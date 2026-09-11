import { PassThrough } from "node:stream";
import {
	asControllerEpoch,
	asThreadId,
	type ClientHelloV2,
	type InitializedNotificationV2,
	PROTOCOL_V2_VERSION,
	type ProtocolV2RequestEnvelope,
	type ServerMessageV2,
} from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import {
	ControllerFencingError,
	ControllerLeaseManager,
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

describe("Protocol v2 Controller Fencing & Leases", () => {
	test("controller lease manager assigns strictly monotonic epochs", () => {
		const manager = new ControllerLeaseManager();
		const threadId = asThreadId("th_epoch_mono");

		const lease1 = manager.acquire(threadId, "ctrl_1", 30000);
		expect(lease1.epoch).toBe(1);
		expect(lease1.controllerId).toBe("ctrl_1");

		const lease2 = manager.acquire(threadId, "ctrl_2", 30000);
		expect(lease2.epoch).toBe(2);
		expect(lease2.controllerId).toBe("ctrl_2");

		const lease3 = manager.acquire(threadId, "ctrl_1", 30000);
		expect(lease3.epoch).toBe(3);

		manager.dispose();
	});

	test("stale epoch is rejected on validation", () => {
		const manager = new ControllerLeaseManager();
		const threadId = asThreadId("th_stale_epoch");

		manager.acquire(threadId, "ctrl_1", 30000);
		manager.acquire(threadId, "ctrl_2", 30000); // Advances epoch to 2

		// Validating with stale epoch 1 must throw ControllerFencingError
		expect(() => manager.validateEpoch(threadId, asControllerEpoch(1))).toThrow(ControllerFencingError);

		// Validating with epoch 2 must succeed
		const valid = manager.validateEpoch(threadId, asControllerEpoch(2));
		expect(valid.controllerId).toBe("ctrl_2");

		manager.dispose();
	});

	test("lease renewal requires exact controller and epoch match", () => {
		const manager = new ControllerLeaseManager();
		const threadId = asThreadId("th_renew");

		const lease = manager.acquire(threadId, "ctrl_1", 10000);
		const initialExpiry = lease.expiresAt;

		// Renew with matching credentials succeeds
		const renewed = manager.renew(threadId, "ctrl_1", asControllerEpoch(1), 20000);
		expect(renewed.expiresAt).toBeGreaterThan(initialExpiry);

		// Renew with wrong controller throws
		expect(() => manager.renew(threadId, "ctrl_imposter", asControllerEpoch(1), 20000)).toThrow(
			ControllerFencingError,
		);

		// Renew with wrong epoch throws
		expect(() => manager.renew(threadId, "ctrl_1", asControllerEpoch(99), 20000)).toThrow(ControllerFencingError);

		manager.dispose();
	});

	test("superseded lease triggers revocation notification", () => {
		const manager = new ControllerLeaseManager();
		const threadId = asThreadId("th_revoke_sub");

		const revocations: Array<{ leaseEpoch: number; reason: string }> = [];
		manager.onLeaseRevoked(threadId, (lease, reason) => {
			revocations.push({ leaseEpoch: lease.epoch, reason });
		});

		manager.acquire(threadId, "ctrl_1", 30000);
		expect(revocations.length).toBe(0);

		// Controller 2 acquires -> supersedes Controller 1
		manager.acquire(threadId, "ctrl_2", 30000);
		expect(revocations.length).toBe(1);
		expect(revocations[0].leaseEpoch).toBe(1);
		expect(revocations[0].reason).toBe("superseded");

		// Controller 2 explicitly releases
		manager.release(threadId, "ctrl_2", asControllerEpoch(2));
		expect(revocations.length).toBe(2);
		expect(revocations[1].leaseEpoch).toBe(2);
		expect(revocations[1].reason).toBe("released");

		manager.dispose();
	});

	test("server rejects turn/start carrying stale epoch over wire", async () => {
		const host = new RuntimeHostImpl("host_fencing", new HostLifecycleCoordinatorImpl());
		const server = new ProtocolV2Server({ runtimeHost: host });

		const { serverTransport, clientTransport } = createConnectedPair();
		server.accept(serverTransport);
		await performHandshake(clientTransport);

		const received: ServerMessageV2[] = [];
		clientTransport.onMessage((msg) => {
			received.push(msg as unknown as ServerMessageV2);
		});

		const threadId = "th_wire_fencing";

		// 1. Acquire controller -> epoch 1
		const acq1: ProtocolV2RequestEnvelope = {
			type: "request",
			id: "cmd_acq1" as any,
			request: {
				command: "controller/acquire",
				threadId: threadId as any,
				controllerId: "ctrl_initial",
			},
		};
		await clientTransport.send(acq1 as any);
		await new Promise((r) => setTimeout(r, 40));

		// 2. Another controller acquires -> epoch 2
		const acq2: ProtocolV2RequestEnvelope = {
			type: "request",
			id: "cmd_acq2" as any,
			request: {
				command: "controller/acquire",
				threadId: threadId as any,
				controllerId: "ctrl_second",
			},
		};
		await clientTransport.send(acq2 as any);
		await new Promise((r) => setTimeout(r, 40));

		// 3. Stale controller attempts turn/start with epoch 1
		const staleStart: ProtocolV2RequestEnvelope = {
			type: "request",
			id: "cmd_stale_turn" as any,
			request: {
				command: "turn/start",
				threadId: threadId as any,
				input: "Late command",
				clientRequestId: "req_stale_1" as any,
				controllerEpoch: 1 as any, // Stale!
			},
		};
		await clientTransport.send(staleStart as any);
		await new Promise((r) => setTimeout(r, 50));

		const lastResponse = received[received.length - 1];
		expect(lastResponse.type).toBe("response");
		if (lastResponse.type === "response") {
			expect(lastResponse.ok).toBe(false);
			if (!lastResponse.ok) {
				expect(lastResponse.error.code).toBe("controller_fencing_error");
			}
		}

		await server.close();
		await clientTransport.close();
	});

	test("disconnecting client holding lease automatically releases lease", async () => {
		const host = new RuntimeHostImpl("host_dc", new HostLifecycleCoordinatorImpl());
		const server = new ProtocolV2Server({ runtimeHost: host });

		const { serverTransport, clientTransport } = createConnectedPair();
		const connId = server.accept(serverTransport);
		await performHandshake(clientTransport);

		const threadId = asThreadId("th_dc_lease");

		// Client acquires lease using its own connection ID as controllerId
		const acq: ProtocolV2RequestEnvelope = {
			type: "request",
			id: "cmd_acq_dc" as any,
			request: {
				command: "controller/acquire",
				threadId: threadId as any,
				controllerId: connId,
			},
		};
		await clientTransport.send(acq as any);
		await new Promise((r) => setTimeout(r, 40));

		expect(server.leaseManager.getActiveLease(threadId)).toBeDefined();

		// Client disconnects
		await clientTransport.close();
		await new Promise((r) => setTimeout(r, 50));

		// Lease should be revoked
		expect(server.leaseManager.getActiveLease(threadId)).toBeUndefined();

		await server.close();
	});
});
