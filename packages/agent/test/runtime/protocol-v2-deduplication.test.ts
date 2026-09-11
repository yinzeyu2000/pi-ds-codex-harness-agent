import { PassThrough } from "node:stream";
import {
	asClientRequestId,
	asThreadId,
	type ClientHelloV2,
	type DeduplicationKey,
	type InitializedNotificationV2,
	PROTOCOL_V2_VERSION,
	type ProtocolV2RequestEnvelope,
	type ServerMessageV2,
} from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import {
	CommandDeduplicationConflictError,
	CommandDeduplicator,
	HostLifecycleCoordinatorImpl,
	ProtocolV2Server,
	RuntimeHostImpl,
} from "../../src/runtime/index.ts";
import { StdioTransport } from "../../src/runtime/node.ts";

function createConnectedPair() {
	const c2s = new PassThrough();
	const s2c = new PassThrough();
	const serverTransport = new StdioTransport(c2s, s2c, { id: "server_side" });
	const clientTransport = new StdioTransport(s2c, c2s, { id: "client_side" });
	return { serverTransport, clientTransport };
}

async function performHandshake(clientTransport: StdioTransport): Promise<void> {
	const hello: ClientHelloV2 = {
		type: "hello",
		version: PROTOCOL_V2_VERSION,
		clientInfo: { name: "test-client", version: "1.0.0" },
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

describe("Protocol v2 Command Deduplication", () => {
	test("deduplicator admits new command and stores admission receipt", () => {
		const dedupe = new CommandDeduplicator();
		const key: DeduplicationKey = {
			principalId: "client_1",
			threadId: asThreadId("th_dedupe_1"),
			method: "turn/start",
			clientRequestId: asClientRequestId("req_101"),
		};

		const status = dedupe.checkOrAdmit(key, { prompt: "Hello world" });
		expect(status.type).toBe("new");
		if (status.type === "new") {
			expect(status.admission.clientRequestId).toBe("req_101");
			expect(status.admission.status).toBe("admitted");
			expect(status.admission.payloadHash).toBeDefined();
		}
	});

	test("conflicting payload with same dedupeKey throws CommandDeduplicationConflictError", () => {
		const dedupe = new CommandDeduplicator();
		const key: DeduplicationKey = {
			principalId: "client_1",
			threadId: asThreadId("th_dedupe_conflict"),
			method: "turn/start",
			clientRequestId: asClientRequestId("req_conflict"),
		};

		dedupe.checkOrAdmit(key, { prompt: "Original prompt" });

		// Attempting with altered payload must throw
		expect(() => {
			dedupe.checkOrAdmit(key, { prompt: "Tampered prompt" });
		}).toThrow(CommandDeduplicationConflictError);
	});

	test("settled command returns recorded result receipt on duplicate call", () => {
		const dedupe = new CommandDeduplicator();
		const key: DeduplicationKey = {
			principalId: "client_1",
			threadId: asThreadId("th_dedupe_settled"),
			method: "turn/start",
			clientRequestId: asClientRequestId("req_settled"),
		};

		dedupe.checkOrAdmit(key, { prompt: "Run once" });
		dedupe.settle(key, true, { turnId: "turn_done_1" });

		// Repeat check with identical payload returns settled receipt
		const secondCheck = dedupe.checkOrAdmit(key, { prompt: "Run once" });
		expect(secondCheck.type).toBe("settled");
		if (secondCheck.type === "settled") {
			expect(secondCheck.receipt.ok).toBe(true);
			expect(secondCheck.receipt.result).toEqual({ turnId: "turn_done_1" });
		}
	});

	test("concurrent in-flight duplicates join the same promise", async () => {
		const dedupe = new CommandDeduplicator();
		const key: DeduplicationKey = {
			principalId: "client_1",
			threadId: asThreadId("th_in_flight"),
			method: "turn/start",
			clientRequestId: asClientRequestId("req_concurrent"),
		};

		const first = dedupe.checkOrAdmit(key, { x: 1 });
		expect(first.type).toBe("new");

		const second = dedupe.checkOrAdmit(key, { x: 1 });
		expect(second.type).toBe("in_flight");

		if (second.type === "in_flight") {
			dedupe.settle(key, true, { completed: true });
			const result = await second.promise;
			expect(result.ok).toBe(true);
			expect(result.result).toEqual({ completed: true });
		}
	});

	test("LRU eviction bounds deduplication memory", () => {
		const dedupe = new CommandDeduplicator(3); // Small capacity limit

		for (let i = 1; i <= 5; i++) {
			const key: DeduplicationKey = {
				principalId: "client_1",
				threadId: asThreadId(`th_${i}`),
				method: "turn/start",
				clientRequestId: asClientRequestId(`req_${i}`),
			};
			dedupe.checkOrAdmit(key, { i });
			dedupe.settle(key, true, { turnId: `turn_${i}` });
		}

		expect(dedupe.size).toBeLessThanOrEqual(3);
	});

	test("server rejects conflicting payload over wire with deduplication_conflict", async () => {
		const host = new RuntimeHostImpl("host_wire_dedupe", new HostLifecycleCoordinatorImpl());
		const server = new ProtocolV2Server({ runtimeHost: host });

		const { serverTransport, clientTransport } = createConnectedPair();
		const connId = server.accept(serverTransport);
		await performHandshake(clientTransport);

		const received: ServerMessageV2[] = [];
		clientTransport.onMessage((msg) => {
			received.push(msg as unknown as ServerMessageV2);
		});

		const threadId = "th_wire_dedupe";

		// 1. Acquire controller
		const acq: ProtocolV2RequestEnvelope = {
			type: "request",
			id: "cmd_acq" as any,
			request: {
				command: "controller/acquire",
				threadId: threadId as any,
				controllerId: connId,
			},
		};
		await clientTransport.send(acq as any);
		await new Promise((r) => setTimeout(r, 40));

		// 2. Submit initial turn/start
		const start1: ProtocolV2RequestEnvelope = {
			type: "request",
			id: "cmd_start1" as any,
			request: {
				command: "turn/start",
				threadId: threadId as any,
				input: "Original input",
				clientRequestId: "req_dup_test" as any,
				controllerEpoch: 1 as any,
			},
		};
		await clientTransport.send(start1 as any);
		await new Promise((r) => setTimeout(r, 40));

		// 3. Submit second turn/start with SAME clientRequestId but DIFFERENT payload
		const start2: ProtocolV2RequestEnvelope = {
			type: "request",
			id: "cmd_start2" as any,
			request: {
				command: "turn/start",
				threadId: threadId as any,
				input: "Different altered input",
				clientRequestId: "req_dup_test" as any,
				controllerEpoch: 1 as any,
			},
		};
		await clientTransport.send(start2 as any);
		await new Promise((r) => setTimeout(r, 40));

		const conflictResponse = received[received.length - 1];
		expect(conflictResponse.type).toBe("response");
		if (conflictResponse.type === "response") {
			expect(conflictResponse.ok).toBe(false);
			if (!conflictResponse.ok) {
				expect(conflictResponse.error.code).toBe("deduplication_conflict");
			}
		}

		await server.close();
		await clientTransport.close();
	});
});
