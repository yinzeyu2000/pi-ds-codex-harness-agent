import { PassThrough } from "node:stream";
import { asThreadId, type WireEventEnvelope } from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import {
	DiagnosticClient,
	HostLifecycleCoordinatorImpl,
	MemoryJournalStore,
	ProtocolV2Server,
	RuntimeHostImpl,
} from "../../src/runtime/index.ts";
import { StdioTransport } from "../../src/runtime/node.ts";

function createConnectedPair(id = "fuzz_pair") {
	const c2s = new PassThrough();
	const s2c = new PassThrough();

	const serverTransport = new StdioTransport(c2s, s2c, { id: `server_${id}` });
	const clientTransport = new StdioTransport(s2c, c2s, { id: `client_${id}` });

	return { serverTransport, clientTransport };
}

describe("M9 Reliability: Protocol Fuzz & Malformed Client Protection", () => {
	it("rejects command mutations when client has no valid controller lease", async () => {
		const host = new RuntimeHostImpl("host_fuzz", new HostLifecycleCoordinatorImpl());
		const store = new MemoryJournalStore();
		const server = new ProtocolV2Server({ runtimeHost: host, journalStore: store });

		const pair = createConnectedPair("unfenced");
		server.accept(pair.serverTransport);
		const client = new DiagnosticClient(pair.clientTransport);
		await client.handshake();

		// Attempt to start turn without acquiring controller lease first
		const threadId = asThreadId("th_unfenced_test");

		await expect(client.startTurn(threadId, "prompt without lease", "req_unfenced_1", 1)).rejects.toThrow(
			/fencing|lease|controller/i,
		);

		await client.close();
		await server.close();
	});

	it("returns cached receipt on duplicate clientRequestId without repeating action", async () => {
		const host = new RuntimeHostImpl("host_fuzz", new HostLifecycleCoordinatorImpl());
		const store = new MemoryJournalStore();
		const server = new ProtocolV2Server({ runtimeHost: host, journalStore: store });

		const pair = createConnectedPair("dedupe");
		server.accept(pair.serverTransport);
		const client = new DiagnosticClient(pair.clientTransport);
		await client.handshake();

		const threadId = asThreadId("th_dedupe_fuzz");

		// Acquire controller
		const lease = await client.acquireController(threadId);
		expect(lease.epoch).toBeDefined();

		// Send startTurn with a fixed clientRequestId twice
		const reqId = "custom_client_req_12345";
		const res1 = await client.startTurn(threadId, "duplicate prompt", reqId, lease.epoch);
		const res2 = await client.startTurn(threadId, "duplicate prompt", reqId, lease.epoch);

		expect(res1).toBeDefined();
		expect(res2).toEqual(res1);

		await client.close();
		await server.close();
	});

	it("isolates slow observer: fast client continues receiving real-time events without lag", async () => {
		const host = new RuntimeHostImpl("host_fuzz", new HostLifecycleCoordinatorImpl());
		const store = new MemoryJournalStore();
		const server = new ProtocolV2Server({ runtimeHost: host, journalStore: store });

		const threadId = asThreadId("th_slow_observer");

		// Client 1: Fast Controller
		const fastPair = createConnectedPair("fast");
		server.accept(fastPair.serverTransport);
		const fastClient = new DiagnosticClient(fastPair.clientTransport);
		await fastClient.handshake();

		// Client 2: Slow Observer
		const slowPair = createConnectedPair("slow");
		server.accept(slowPair.serverTransport);
		const slowClient = new DiagnosticClient(slowPair.clientTransport);
		await slowClient.handshake();

		const fastEvents: WireEventEnvelope[] = [];
		const slowEvents: WireEventEnvelope[] = [];

		fastClient.onWireEvent((e) => {
			fastEvents.push(e);
		});

		slowClient.onWireEvent(async (e) => {
			// Simulate slow observer delay
			await new Promise((resolve) => setTimeout(resolve, 30));
			slowEvents.push(e);
		});

		await fastClient.watchThread(threadId);
		await slowClient.watchThread(threadId);

		const lease = await fastClient.acquireController(threadId);

		// Start a turn from fast client
		const start = Date.now();
		await fastClient.startTurn(threadId, "fast prompt", "req_fast_1", lease.epoch);

		// Fast client receives turn/admitted promptly
		const elapsedFast = Date.now() - start;
		expect(fastEvents.length).toBeGreaterThan(0);
		// Fast client execution was not blocked by slow observer
		expect(elapsedFast).toBeLessThan(100);

		await fastClient.close();
		await slowClient.close();
		await server.close();
	});

	it("handles malformed unknown methods gracefully by replying with stable error without crashing", async () => {
		const host = new RuntimeHostImpl("host_fuzz", new HostLifecycleCoordinatorImpl());
		const store = new MemoryJournalStore();
		const server = new ProtocolV2Server({ runtimeHost: host, journalStore: store });

		const pair = createConnectedPair("unknown_method");
		server.accept(pair.serverTransport);
		const client = new DiagnosticClient(pair.clientTransport);
		await client.handshake();

		// Send unknown / malformed method
		const res = await (client as any).sendRequest({ command: "unknown/nonexistent_method" });
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error.code).toBe("not_implemented");
		}

		// Server must still be alive and responsive to subsequent requests
		const threadId = asThreadId("th_alive_test");
		const lease = await client.acquireController(threadId);
		expect(lease.epoch).toBeDefined();

		await client.close();
		await server.close();
	});
});
