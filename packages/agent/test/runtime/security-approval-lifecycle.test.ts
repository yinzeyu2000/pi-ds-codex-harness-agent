import { asThreadId, asTurnId } from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import { ApprovalManagerImpl, computeApprovalFingerprint } from "../../src/runtime/index.ts";

describe("M6 Security Approval Lifecycle & Fingerprint Fencing", () => {
	const baseInput = {
		threadId: "th_test",
		turnId: "turn_1",
		toolAttemptId: "att_1",
		toolName: "bash",
		command: "git",
		args: ["status"],
		cwd: "/workspace/repo",
		readRoots: ["/workspace"],
		writeRoots: ["/workspace/build"],
		sandboxMode: "secure",
		controllerEpoch: 1,
	};

	describe("Approval Fingerprint Computation", () => {
		it("generates deterministic SHA-256 hex string", async () => {
			const fp1 = await computeApprovalFingerprint(baseInput);
			const fp2 = await computeApprovalFingerprint(baseInput);
			expect(fp1).toBe(fp2);
			expect(fp1.length).toBe(64);
		});

		it("produces different fingerprints when parameters are altered", async () => {
			const baseFp = await computeApprovalFingerprint(baseInput);

			// Altering command
			const diffCmd = await computeApprovalFingerprint({ ...baseInput, command: "npm" });
			expect(diffCmd).not.toBe(baseFp);

			// Altering args
			const diffArgs = await computeApprovalFingerprint({ ...baseInput, args: ["checkout", "main"] });
			expect(diffArgs).not.toBe(baseFp);

			// Altering cwd
			const diffCwd = await computeApprovalFingerprint({ ...baseInput, cwd: "/different/path" });
			expect(diffCwd).not.toBe(baseFp);

			// Altering readRoots
			const diffRoots = await computeApprovalFingerprint({ ...baseInput, readRoots: ["/other"] });
			expect(diffRoots).not.toBe(baseFp);

			// Altering controllerEpoch (fencing boundary)
			const diffEpoch = await computeApprovalFingerprint({ ...baseInput, controllerEpoch: 2 });
			expect(diffEpoch).not.toBe(baseFp);
		});
	});

	describe("ApprovalManagerImpl Lifecycle", () => {
		it("resolves approval requests successfully", async () => {
			const manager = new ApprovalManagerImpl();
			const fp = await computeApprovalFingerprint(baseInput);

			const requestPromise = manager.requestApproval({
				requestId: "req_1",
				turnId: asTurnId("turn_1"),
				toolAttemptId: "att_1" as any,
				toolName: "bash",
				fingerprint: fp,
				description: "Run git status",
				expiresAt: Date.now() + 5000,
			});

			expect(manager.pendingCount).toBe(1);
			expect(manager.getPendingRequest("req_1")).toBeDefined();

			const resolved = manager.resolve("req_1", "approved");
			expect(resolved).toBe(true);

			const decision = await requestPromise;
			expect(decision).toBe("approved");
			expect(manager.pendingCount).toBe(0);
		});

		it("rejects resolution if provided fingerprint does not match (fingerprint binding)", async () => {
			const manager = new ApprovalManagerImpl();
			const fp = await computeApprovalFingerprint(baseInput);

			const requestPromise = manager.requestApproval({
				requestId: "req_mismatch",
				turnId: asTurnId("turn_1"),
				toolAttemptId: "att_1" as any,
				toolName: "bash",
				fingerprint: fp,
				description: "Run git status",
				expiresAt: Date.now() + 5000,
			});

			// Resolve with wrong fingerprint
			const resolved = manager.resolve("req_mismatch", "approved", "wrong_fingerprint_hash");
			expect(resolved).toBe(false);

			// Fail closed: decision is rejected
			const decision = await requestPromise;
			expect(decision).toBe("rejected");
		});

		it("times out and resolves with expired after deadline", async () => {
			const manager = new ApprovalManagerImpl();
			const fp = await computeApprovalFingerprint(baseInput);

			const requestPromise = manager.requestApproval({
				requestId: "req_expire",
				turnId: asTurnId("turn_1"),
				toolAttemptId: "att_1" as any,
				toolName: "bash",
				fingerprint: fp,
				description: "Expiring command",
				expiresAt: Date.now() + 50, // 50ms deadline
			});

			const decision = await requestPromise;
			expect(decision).toBe("expired");
			expect(manager.pendingCount).toBe(0);
		});

		it("cancels all pending approvals when controller lease is lost (cancelAllForThread)", async () => {
			const manager = new ApprovalManagerImpl();
			const threadId = asThreadId("th_lease_lost");

			const p1 = manager.requestApproval({
				requestId: "req_t1",
				turnId: asTurnId("turn_1"),
				toolAttemptId: "att_1" as any,
				toolName: "bash",
				fingerprint: "fp1",
				description: "t1",
				expiresAt: Date.now() + 10000,
				threadId,
			});

			const p2 = manager.requestApproval({
				requestId: "req_t2",
				turnId: asTurnId("turn_2"),
				toolAttemptId: "att_2" as any,
				toolName: "bash",
				fingerprint: "fp2",
				description: "t2",
				expiresAt: Date.now() + 10000,
				threadId,
			});

			expect(manager.pendingCount).toBe(2);

			// Simulate controller lease revocation
			const cancelled = manager.cancelAllForThread(threadId, "controller_lease_lost");
			expect(cancelled).toBe(2);

			const [res1, res2] = await Promise.all([p1, p2]);
			expect(res1).toBe("rejected");
			expect(res2).toBe("rejected");
			expect(manager.pendingCount).toBe(0);
		});

		it("verifies TOCTOU pre-execution fingerprint correctly", async () => {
			const manager = new ApprovalManagerImpl();
			const fp = await computeApprovalFingerprint(baseInput);

			const approvedReq = {
				requestId: "req_toctou",
				turnId: asTurnId("turn_1"),
				toolAttemptId: "att_1" as any,
				toolName: "bash",
				fingerprint: fp,
				description: "git status",
				expiresAt: Date.now() + 10000,
			};

			// Same input right before execution
			const ok = await manager.verifyPreExecutionFingerprint(approvedReq, baseInput);
			expect(ok).toBe(true);

			// Argument altered before execution (TOCTOU attack attempt)
			const tamperedInput = { ...baseInput, args: ["push", "--force"] };
			const tampered = await manager.verifyPreExecutionFingerprint(approvedReq, tamperedInput);
			expect(tampered).toBe(false);
		});
	});
});
