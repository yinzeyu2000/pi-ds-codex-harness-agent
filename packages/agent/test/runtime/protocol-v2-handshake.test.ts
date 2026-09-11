import { PassThrough } from "node:stream";
import {
	type ClientHelloV2,
	type InitializedNotificationV2,
	PROTOCOL_V2_VERSION,
	type ProtocolV2RequestEnvelope,
	type ServerHelloV2,
	type ServerMessageV2,
} from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { HostLifecycleCoordinatorImpl, ProtocolV2Server, RuntimeHostImpl } from "../../src/runtime/index.ts";
import { StdioTransport } from "../../src/runtime/node.ts";

function createConnectedPair() {
	const clientToSever = new PassThrough();
	const serverToClient = new PassThrough();

	const serverTransport = new StdioTransport(clientToSever, serverToClient, { id: "server_side" });
	const clientTransport = new StdioTransport(serverToClient, clientToSever, { id: "client_side" });

	return { serverTransport, clientTransport };
}

describe("Protocol v2 Handshake & Capabilities", () => {
	test("successful 3-way handshake unlocks command execution", async () => {
		const host = new RuntimeHostImpl("host_test", new HostLifecycleCoordinatorImpl());
		const server = new ProtocolV2Server({ runtimeHost: host });

		const { serverTransport, clientTransport } = createConnectedPair();
		server.accept(serverTransport);

		const receivedMessages: ServerMessageV2[] = [];
		clientTransport.onMessage((msg) => {
			receivedMessages.push(msg as unknown as ServerMessageV2);
		});

		// 1. Client sends hello
		const hello: ClientHelloV2 = {
			type: "hello",
			version: PROTOCOL_V2_VERSION,
			clientInfo: { name: "test-client", version: "1.0.0", uiType: "cli" },
			capabilities: {
				streamingDeltas: true,
				approvalPrompts: true,
				controllerLease: true,
				binaryFrames: false,
				processInteractivePty: false,
			},
		};
		await clientTransport.send(hello as any);

		// Wait for ServerHello
		await new Promise((r) => setTimeout(r, 50));
		expect(receivedMessages.length).toBe(1);
		const serverHello = receivedMessages[0] as ServerHelloV2;
		expect(serverHello.type).toBe("hello");
		expect(serverHello.version).toBe(2);
		expect(serverHello.serverCapabilities.fencedControllers).toBe(true);
		expect(serverHello.serverCapabilities.commandDeduplication).toBe(true);

		// 2. Client sends initialized
		const init: InitializedNotificationV2 = {
			type: "initialized",
			protocolVersion: PROTOCOL_V2_VERSION,
		};
		await clientTransport.send(init as any);
		await new Promise((r) => setTimeout(r, 20));

		// 3. Ready phase: client can now send commands
		const req: ProtocolV2RequestEnvelope = {
			type: "request",
			id: "cmd_test_1" as any,
			request: {
				command: "controller/acquire",
				threadId: "th_test_handshake" as any,
				controllerId: "ctrl_1",
				ttlMs: 30000,
			},
		};
		await clientTransport.send(req as any);

		await new Promise((r) => setTimeout(r, 50));
		expect(receivedMessages.length).toBe(2);
		const response = receivedMessages[1];
		expect(response.type).toBe("response");
		if (response.type === "response") {
			expect(response.ok).toBe(true);
			if (response.ok) {
				expect(response.result.command).toBe("controller/acquire");
			}
		}

		await server.close();
		await clientTransport.close();
	});

	test("unsupported protocol version fails handshake immediately", async () => {
		const host = new RuntimeHostImpl("host_test", new HostLifecycleCoordinatorImpl());
		const server = new ProtocolV2Server({ runtimeHost: host });

		const { serverTransport, clientTransport } = createConnectedPair();
		server.accept(serverTransport);

		const receivedMessages: ServerMessageV2[] = [];
		clientTransport.onMessage((msg) => {
			receivedMessages.push(msg as unknown as ServerMessageV2);
		});

		const invalidHello = {
			type: "hello",
			version: 999, // unsupported
			clientInfo: { name: "bad-client", version: "0.1" },
			capabilities: {},
		};
		await clientTransport.send(invalidHello as any);

		await new Promise((r) => setTimeout(r, 50));
		expect(receivedMessages.length).toBe(1);
		const err = receivedMessages[0];
		expect(err.type).toBe("hello_error");
		if (err.type === "hello_error") {
			expect(err.code).toBe("unsupported_version");
		}

		await server.close();
		await clientTransport.close();
	});

	test("sending request before hello is rejected as protocol violation", async () => {
		const host = new RuntimeHostImpl("host_test", new HostLifecycleCoordinatorImpl());
		const server = new ProtocolV2Server({ runtimeHost: host });

		const { serverTransport, clientTransport } = createConnectedPair();
		server.accept(serverTransport);

		const receivedMessages: ServerMessageV2[] = [];
		clientTransport.onMessage((msg) => {
			receivedMessages.push(msg as unknown as ServerMessageV2);
		});

		const earlyRequest: ProtocolV2RequestEnvelope = {
			type: "request",
			id: "cmd_early" as any,
			request: {
				command: "controller/acquire",
				threadId: "th_early" as any,
				controllerId: "ctrl_early",
			},
		};
		await clientTransport.send(earlyRequest as any);

		await new Promise((r) => setTimeout(r, 50));
		expect(receivedMessages.length).toBe(1);
		expect(receivedMessages[0].type).toBe("hello_error");

		await server.close();
		await clientTransport.close();
	});
});
