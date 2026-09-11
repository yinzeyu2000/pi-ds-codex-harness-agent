import { PassThrough } from "node:stream";
import { asThreadId, asTurnId, type WireEventEnvelope } from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import {
	ApprovalManagerImpl,
	DiagnosticClient,
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

describe("M7b Protocol v2 Approval & Multi-UI Wire Integration", () => {
	it("broadcasts approval.requested and approval.resolved across observers and resolves tool", async () => {
		const host = new RuntimeHostImpl("host_appr", new HostLifecycleCoordinatorImpl());
		const store = new MemoryJournalStore();
		const approvalManager = new ApprovalManagerImpl();

		const server = new ProtocolV2Server({
			runtimeHost: host,
			journalStore: store,
			approvalManager,
		});

		// 1. Controller Client
		const ctrlPair = createConnectedPair("ctrl");
		server.accept(ctrlPair.serverTransport);
		const ctrlClient = new DiagnosticClient(ctrlPair.clientTransport);
		await ctrlClient.handshake();

		// 2. Passive Observer Client
		const obsPair = createConnectedPair("obs");
		server.accept(obsPair.serverTransport);
		const obsClient = new DiagnosticClient(obsPair.clientTransport);
		await obsClient.handshake();

		const threadId = asThreadId("th_appr_flow");

		// Both watch the thread
		await ctrlClient.watchThread(threadId);
		await obsClient.watchThread(threadId);

		const ctrlEvents: WireEventEnvelope[] = [];
		ctrlClient.onWireEvent((e) => ctrlEvents.push(e));

		const obsEvents: WireEventEnvelope[] = [];
		obsClient.onWireEvent((e) => obsEvents.push(e));

		// Controller acquires lease -> epoch 1
		const lease = await ctrlClient.acquireController(threadId);
		expect(lease.epoch).toBe(1);

		// Trigger an approval request directly on ApprovalManager
		const approvalPromise = approvalManager.requestApproval({
			requestId: "req_appr_1",
			turnId: asTurnId("turn_1"),
			toolAttemptId: "att_1" as any,
			toolName: "bash",
			fingerprint: "fp_dummy",
			description: "Execute git status",
			expiresAt: Date.now() + 5000,
			threadId,
			controllerEpoch: 1,
		});

		// Wait for event broadcast
		await new Promise((r) => setTimeout(r, 40));

		// Both controller and observer received approval.requested event
		const ctrlApprReq = ctrlEvents.find((e) => e.type === "approval.requested");
		const obsApprReq = obsEvents.find((e) => e.type === "approval.requested");
		expect(ctrlApprReq).toBeDefined();
		expect(obsApprReq).toBeDefined();
		expect(ctrlApprReq?.payload).toMatchObject({
			requestId: "req_appr_1",
			toolName: "bash",
		});
		expect(obsApprReq?.payload).toMatchObject({
			requestId: "req_appr_1",
			toolName: "bash",
		});

		// Controller responds to approval
		await ctrlClient.respondApproval(threadId, "turn_1", "req_appr_1", "approved");

		const decision = await approvalPromise;
		expect(decision).toBe("approved");

		// Wait for resolution broadcast
		await new Promise((r) => setTimeout(r, 40));

		const ctrlApprRes = ctrlEvents.find((e) => e.type === "approval.resolved");
		const obsApprRes = obsEvents.find((e) => e.type === "approval.resolved");
		expect(ctrlApprRes).toBeDefined();
		expect(obsApprRes).toBeDefined();
		expect(ctrlApprRes?.payload).toMatchObject({
			requestId: "req_appr_1",
			decision: "approved",
		});
		expect(obsApprRes?.payload).toMatchObject({
			requestId: "req_appr_1",
			decision: "approved",
		});

		await ctrlClient.close();
		await obsClient.close();
		await server.close();
	});

	it("rejects approval response from passive observer (controller fencing)", async () => {
		const host = new RuntimeHostImpl("host_fencing", new HostLifecycleCoordinatorImpl());
		const approvalManager = new ApprovalManagerImpl();

		const server = new ProtocolV2Server({
			runtimeHost: host,
			approvalManager,
		});

		// Controller
		const ctrlPair = createConnectedPair("ctrl");
		server.accept(ctrlPair.serverTransport);
		const ctrlClient = new DiagnosticClient(ctrlPair.clientTransport);
		await ctrlClient.handshake();

		// Passive Observer
		const obsPair = createConnectedPair("obs");
		server.accept(obsPair.serverTransport);
		const obsClient = new DiagnosticClient(obsPair.clientTransport);
		await obsClient.handshake();

		const threadId = asThreadId("th_fencing_appr");
		await ctrlClient.acquireController(threadId);

		// Passive observer tries to respond to approval with epoch 1
		await expect(obsClient.respondApproval(threadId, "turn_1", "req_fake", "approved", undefined, 1)).rejects.toThrow(
			/Controller mismatch/,
		);

		await ctrlClient.close();
		await obsClient.close();
		await server.close();
	});

	it("cancels pending approvals fail-closed when controller lease is revoked or disconnected", async () => {
		const host = new RuntimeHostImpl("host_revocation", new HostLifecycleCoordinatorImpl());
		const approvalManager = new ApprovalManagerImpl();

		const server = new ProtocolV2Server({
			runtimeHost: host,
			approvalManager,
		});

		// Controller
		const ctrlPair = createConnectedPair("ctrl");
		server.accept(ctrlPair.serverTransport);
		const ctrlClient = new DiagnosticClient(ctrlPair.clientTransport);
		await ctrlClient.handshake();

		// Observer
		const obsPair = createConnectedPair("obs");
		server.accept(obsPair.serverTransport);
		const obsClient = new DiagnosticClient(obsPair.clientTransport);
		await obsClient.handshake();

		const threadId = asThreadId("th_fail_closed");
		await ctrlClient.watchThread(threadId);
		await obsClient.watchThread(threadId);

		const obsEvents: WireEventEnvelope[] = [];
		obsClient.onWireEvent((e) => obsEvents.push(e));

		await ctrlClient.acquireController(threadId);

		// Trigger pending approval
		const approvalPromise = approvalManager.requestApproval({
			requestId: "req_lost",
			turnId: asTurnId("turn_1"),
			toolAttemptId: "att_1" as any,
			toolName: "bash",
			fingerprint: "fp_lost",
			description: "Pending action",
			expiresAt: Date.now() + 10000,
			threadId,
			controllerEpoch: 1,
		});

		expect(approvalManager.pendingCount).toBe(1);

		// Controller disconnects!
		await ctrlClient.close();

		// Approval must fail closed and resolve with rejected
		const decision = await approvalPromise;
		expect(decision).toBe("rejected");
		expect(approvalManager.pendingCount).toBe(0);

		// Observer must receive approval.resolved notification
		await new Promise((r) => setTimeout(r, 50));
		const resolvedEvent = obsEvents.find((e) => e.type === "approval.resolved");
		expect(resolvedEvent).toBeDefined();
		expect(resolvedEvent?.payload).toMatchObject({
			requestId: "req_lost",
			decision: "rejected",
		});

		await obsClient.close();
		await server.close();
	});
});
