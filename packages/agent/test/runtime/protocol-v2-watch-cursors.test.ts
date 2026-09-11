import { PassThrough } from "node:stream";
import {
	type ClientHelloV2,
	type InitializedNotificationV2,
	PROTOCOL_V2_VERSION,
	type ProtocolV2RequestEnvelope,
	type ServerMessageV2,
} from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import {
	FakeDriver,
	HostLifecycleCoordinatorImpl,
	MemoryJournalStore,
	ProtocolV2Server,
	RuntimeHostImpl,
} from "../../src/runtime/index.ts";
import { StdioTransport } from "../../src/runtime/node.ts";

function createConnectedPair(id: string) {
	const c2s = new PassThrough();
	const s2c = new PassThrough();
	const serverTransport = new StdioTransport(c2s, s2c, { id: `srv_${id}` });
	const clientTransport = new StdioTransport(s2c, c2s, { id: `cli_${id}` });
	return { serverTransport, clientTransport };
}

async function performHandshake(clientTransport: StdioTransport, name: string): Promise<void> {
	const hello: ClientHelloV2 = {
		type: "hello",
		version: PROTOCOL_V2_VERSION,
		clientInfo: { name, version: "1.0.0" },
		capabilities: {
			streamingDeltas: true,
			approvalPrompts: true,
			controllerLease: true,
			binaryFrames: false,
			processInteractivePty: false,
		},
	};
	await clientTransport.send(hello as any);
	await new Promise((r) => setTimeout(r, 20));

	const init: InitializedNotificationV2 = {
		type: "initialized",
		protocolVersion: PROTOCOL_V2_VERSION,
	};
	await clientTransport.send(init as any);
	await new Promise((r) => setTimeout(r, 20));
}

describe("Protocol v2 Watch Cursors & Dual Observers", () => {
	test("thread/watch returns snapshot and durable watermark sequence", async () => {
		const host = new RuntimeHostImpl("host_watch", new HostLifecycleCoordinatorImpl());
		const store = new MemoryJournalStore();
		const server = new ProtocolV2Server({
			runtimeHost: host,
			journalStore: store,
			driverFactory: () => new FakeDriver("completed", "finished"),
		});

		const { serverTransport, clientTransport } = createConnectedPair("1");
		server.accept(serverTransport);
		await performHandshake(clientTransport, "client-1");

		const received: ServerMessageV2[] = [];
		clientTransport.onMessage((msg) => {
			received.push(msg as unknown as ServerMessageV2);
		});

		const threadId = "th_watch_snap";

		const watchReq: ProtocolV2RequestEnvelope = {
			type: "request",
			id: "cmd_watch_1" as any,
			request: {
				command: "thread/watch",
				threadId: threadId as any,
			},
		};
		await clientTransport.send(watchReq as any);
		await new Promise((r) => setTimeout(r, 40));

		const response = received.find((m) => m.type === "response" && m.id === "cmd_watch_1");
		expect(response).toBeDefined();
		if (response && response.type === "response" && response.ok && response.result.command === "thread/watch") {
			expect(response.result.threadId).toBe(threadId);
			expect(response.result.snapshot).toBeDefined();
			expect(typeof response.result.durableWatermarkSeq).toBe("number");
		}

		await server.close();
		await clientTransport.close();
	});

	test("two independent observers observe identical snapshot and event streams", async () => {
		const host = new RuntimeHostImpl("host_dual", new HostLifecycleCoordinatorImpl());
		const store = new MemoryJournalStore();
		const server = new ProtocolV2Server({
			runtimeHost: host,
			journalStore: store,
			driverFactory: () => new FakeDriver("completed", "turn finished"),
		});

		// Observer 1
		const pair1 = createConnectedPair("obs1");
		server.accept(pair1.serverTransport);
		await performHandshake(pair1.clientTransport, "observer-1");

		// Observer 2
		const pair2 = createConnectedPair("obs2");
		server.accept(pair2.serverTransport);
		await performHandshake(pair2.clientTransport, "observer-2");

		const obs1Events: ServerMessageV2[] = [];
		pair1.clientTransport.onMessage((msg) => {
			obs1Events.push(msg as unknown as ServerMessageV2);
		});

		const obs2Events: ServerMessageV2[] = [];
		pair2.clientTransport.onMessage((msg) => {
			obs2Events.push(msg as unknown as ServerMessageV2);
		});

		const threadId = "th_dual_stream";

		// Both observers subscribe to watch
		const watchCmd1: ProtocolV2RequestEnvelope = {
			type: "request",
			id: "watch_1" as any,
			request: { command: "thread/watch", threadId: threadId as any },
		};
		const watchCmd2: ProtocolV2RequestEnvelope = {
			type: "request",
			id: "watch_2" as any,
			request: { command: "thread/watch", threadId: threadId as any },
		};

		await pair1.clientTransport.send(watchCmd1 as any);
		await pair2.clientTransport.send(watchCmd2 as any);
		await new Promise((r) => setTimeout(r, 40));

		// Observer 1 acquires controller and starts turn
		const acqCmd: ProtocolV2RequestEnvelope = {
			type: "request",
			id: "acq_ctrl" as any,
			request: { command: "controller/acquire", threadId: threadId as any, controllerId: "ctrl_dual" },
		};
		await pair1.clientTransport.send(acqCmd as any);
		await new Promise((r) => setTimeout(r, 40));

		const startTurnCmd: ProtocolV2RequestEnvelope = {
			type: "request",
			id: "start_turn_dual" as any,
			request: {
				command: "turn/start",
				threadId: threadId as any,
				input: "Dual observer test",
				clientRequestId: "req_dual_watch" as any,
				controllerEpoch: 1 as any,
			},
		};
		await pair1.clientTransport.send(startTurnCmd as any);

		// Wait for turn completion
		await new Promise((r) => setTimeout(r, 120));

		// Filter wire events received by both observers
		const filterWireEvents = (messages: ServerMessageV2[]) =>
			messages.filter((m) => m.type === "event").map((m) => (m as any).event.type);

		const events1 = filterWireEvents(obs1Events);
		const events2 = filterWireEvents(obs2Events);

		expect(events1.length).toBeGreaterThanOrEqual(3);
		expect(events1).toEqual(events2);

		expect(events1[0]).toBe("turn.admitted");
		expect(events1[1]).toBe("turn.started");
		expect(events1[events1.length - 1]).toBe("turn.completed");

		await server.close();
		await pair1.clientTransport.close();
		await pair2.clientTransport.close();
	});

	test("thread/watch replays historical durable events when afterSeq is behind watermark", async () => {
		const host = new RuntimeHostImpl("host_replay", new HostLifecycleCoordinatorImpl());
		const store = new MemoryJournalStore();
		const server = new ProtocolV2Server({
			runtimeHost: host,
			journalStore: store,
			driverFactory: () => new FakeDriver("completed", "replay done"),
		});

		const threadId = "th_durable_replay";

		// Client 1: runs turn to generate journal events
		const pair1 = createConnectedPair("writer");
		server.accept(pair1.serverTransport);
		await performHandshake(pair1.clientTransport, "writer");

		await pair1.clientTransport.send({
			type: "request",
			id: "acq_replay" as any,
			request: { command: "controller/acquire", threadId: threadId as any, controllerId: "ctrl_replay" },
		} as any);
		await new Promise((r) => setTimeout(r, 30));

		await pair1.clientTransport.send({
			type: "request",
			id: "start_replay_turn" as any,
			request: {
				command: "turn/start",
				threadId: threadId as any,
				input: "Turn for replay",
				clientRequestId: "req_replay_1" as any,
				controllerEpoch: 1 as any,
			},
		} as any);
		await new Promise((r) => setTimeout(r, 100));

		// Client 2 connects later and watches with afterSeq: 0
		const pair2 = createConnectedPair("reader");
		server.accept(pair2.serverTransport);
		await performHandshake(pair2.clientTransport, "reader");

		const readerEvents: ServerMessageV2[] = [];
		pair2.clientTransport.onMessage((msg) => {
			readerEvents.push(msg as unknown as ServerMessageV2);
		});

		await pair2.clientTransport.send({
			type: "request",
			id: "watch_from_0" as any,
			request: { command: "thread/watch", threadId: threadId as any, afterSeq: 0 },
		} as any);

		await new Promise((r) => setTimeout(r, 80));

		const replayedEvents = readerEvents.filter((m) => m.type === "event");
		expect(replayedEvents.length).toBeGreaterThanOrEqual(1);

		await server.close();
		await pair1.clientTransport.close();
		await pair2.clientTransport.close();
	});
});
