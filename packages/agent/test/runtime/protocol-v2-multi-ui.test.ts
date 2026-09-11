import { PassThrough } from "node:stream";
import { asThreadId, type WireEventEnvelope } from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import {
	DiagnosticClient,
	FakeDriver,
	HostLifecycleCoordinatorImpl,
	MemoryJournalStore,
	ProtocolV2Server,
	RuntimeHostImpl,
} from "../../src/runtime/index.ts";
import { StdioTransport } from "../../src/runtime/node.ts";

function createConnectedPair(id = "pair") {
	const c2s = new PassThrough();
	const s2c = new PassThrough();

	const serverTransport = new StdioTransport(c2s, s2c, { id: `server_${id}` });
	const clientTransport = new StdioTransport(s2c, c2s, { id: `client_${id}` });

	return { serverTransport, clientTransport };
}

describe("M7b Protocol v2 Multi-UI & Controller Transfer Integration", () => {
	it("ensures dual UI observers receive identical event streams in exact order", async () => {
		const host = new RuntimeHostImpl("host_dual_ui", new HostLifecycleCoordinatorImpl());
		const store = new MemoryJournalStore();
		const server = new ProtocolV2Server({
			runtimeHost: host,
			journalStore: store,
			driverFactory: () => new FakeDriver("completed", "Multi-UI turn finished"),
		});

		// UI-1 (Controller)
		const ui1Pair = createConnectedPair("ui1");
		server.accept(ui1Pair.serverTransport);
		const ui1 = new DiagnosticClient(ui1Pair.clientTransport, { clientInfo: { name: "ui-1-controller" } });
		await ui1.handshake();

		// UI-2 (Passive Observer)
		const ui2Pair = createConnectedPair("ui2");
		server.accept(ui2Pair.serverTransport);
		const ui2 = new DiagnosticClient(ui2Pair.clientTransport, { clientInfo: { name: "ui-2-observer" } });
		await ui2.handshake();

		const threadId = asThreadId("th_dual_observers");

		await ui1.watchThread(threadId);
		await ui2.watchThread(threadId);

		const ui1Events: WireEventEnvelope[] = [];
		ui1.onWireEvent((e) => ui1Events.push(e));

		const ui2Events: WireEventEnvelope[] = [];
		ui2.onWireEvent((e) => ui2Events.push(e));

		// UI-1 acquires controller
		await ui1.acquireController(threadId);

		// UI-1 starts turn
		const startRes = await ui1.startTurn(threadId, "Hello Multi-UI");
		expect(startRes.status).toBe("admitted");

		// Wait for turn execution
		await new Promise((r) => setTimeout(r, 80));

		// Verify event sequence parity
		expect(ui1Events.length).toBeGreaterThanOrEqual(2);
		expect(ui2Events.length).toBe(ui1Events.length);

		const ui1Types = ui1Events.map((e) => e.type);
		const ui2Types = ui2Events.map((e) => e.type);
		expect(ui1Types).toEqual(ui2Types);

		await ui1.close();
		await ui2.close();
		await server.close();
	});

	it("rejects mutating commands from non-controller observer (controller fencing)", async () => {
		const host = new RuntimeHostImpl("host_non_ctrl", new HostLifecycleCoordinatorImpl());
		const server = new ProtocolV2Server({ runtimeHost: host });

		// UI-1 Controller
		const ui1Pair = createConnectedPair("ui1");
		server.accept(ui1Pair.serverTransport);
		const ui1 = new DiagnosticClient(ui1Pair.clientTransport);
		await ui1.handshake();

		// UI-2 Passive
		const ui2Pair = createConnectedPair("ui2");
		server.accept(ui2Pair.serverTransport);
		const ui2 = new DiagnosticClient(ui2Pair.clientTransport);
		await ui2.handshake();

		const threadId = asThreadId("th_fencing_enforcement");
		await ui1.acquireController(threadId);

		// UI-2 tries to start turn without lease
		await expect(ui2.startTurn(threadId, "Malicious attempt", "req_bad", 1)).rejects.toThrow(/Controller mismatch/);

		await ui1.close();
		await ui2.close();
		await server.close();
	});

	it("supports seamless controller transfer and invalidates old controller commands", async () => {
		const host = new RuntimeHostImpl("host_transfer", new HostLifecycleCoordinatorImpl());
		const server = new ProtocolV2Server({ runtimeHost: host });

		// UI-1
		const ui1Pair = createConnectedPair("ui1");
		server.accept(ui1Pair.serverTransport);
		const ui1 = new DiagnosticClient(ui1Pair.clientTransport, { clientInfo: { name: "ui-1" } });
		await ui1.handshake();

		// UI-2
		const ui2Pair = createConnectedPair("ui2");
		server.accept(ui2Pair.serverTransport);
		const ui2 = new DiagnosticClient(ui2Pair.clientTransport, { clientInfo: { name: "ui-2" } });
		await ui2.handshake();

		const threadId = asThreadId("th_ctrl_transfer");

		// 1. UI-1 acquires controller lease (epoch 1)
		const lease1 = await ui1.acquireController(threadId);
		expect(lease1.epoch).toBe(1);

		// 2. UI-1 releases controller lease
		const released = await ui1.releaseController(threadId);
		expect(released).toBe(true);

		// 3. UI-2 acquires controller lease (epoch 2)
		const lease2 = await ui2.acquireController(threadId);
		expect(lease2.epoch).toBe(2);

		// 4. UI-1 late command carrying stale epoch 1 is rejected
		await expect(ui1.startTurn(threadId, "Late command from UI-1", "req_late", 1)).rejects.toThrow(
			/Fencing violation|Controller mismatch/,
		);

		// 5. UI-2 command carrying epoch 2 succeeds
		const turnRes = await ui2.startTurn(threadId, "Valid command from UI-2", "req_ui2", 2);
		expect(turnRes.status).toBe("admitted");

		await ui1.close();
		await ui2.close();
		await server.close();
	});

	it("enforces request deduplication: replays identical requests and rejects conflicting payloads", async () => {
		const host = new RuntimeHostImpl("host_dedupe_e2e", new HostLifecycleCoordinatorImpl());
		const server = new ProtocolV2Server({ runtimeHost: host });

		const pair = createConnectedPair("dedupe");
		server.accept(pair.serverTransport);
		const client = new DiagnosticClient(pair.clientTransport);
		await client.handshake();

		const threadId = asThreadId("th_dedupe_e2e");
		await client.acquireController(threadId);

		// 1. First execution
		const res1 = await client.startTurn(threadId, "Hello Dedupe", "req_client_100", 1);
		expect(res1.status).toBe("admitted");

		// 2. Exact duplicate request with identical payload replays settled result
		const res2 = await client.startTurn(threadId, "Hello Dedupe", "req_client_100", 1);
		expect(res2.turnId).toBe(res1.turnId);
		expect(res2.admittedAt).toBe(res1.admittedAt);

		// 3. Conflict request with same clientRequestId but altered payload throws 409 conflict
		await expect(client.startTurn(threadId, "Different Payload", "req_client_100", 1)).rejects.toThrow(
			/deduplication_conflict|payload hash conflict/i,
		);

		await client.close();
		await server.close();
	});
});
