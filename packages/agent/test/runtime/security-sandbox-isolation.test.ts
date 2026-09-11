import { asStepId, asToolAttemptId, asToolCallId, asTurnId } from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import {
	canonicalizePath,
	DefaultPolicyEngine,
	ExecutionBrokerImpl,
	PlatformSandboxProvider,
	SandboxUnsupportedError,
	validatePathWithinRoots,
} from "../../src/runtime/index.ts";
import { ApprovalManagerImpl } from "../../src/runtime/security/approval.ts";

describe("M6 Sandbox Isolation, Path Traversal & ExecutionBroker Security", () => {
	describe("Path Traversal & Canonicalization", () => {
		it("canonicalizes paths resolving relative segments and prevents root escape", () => {
			expect(canonicalizePath("/a/b/../c")).toBe("/a/c");
			expect(canonicalizePath("/workspace/repo/../../etc/passwd")).toBe("/etc/passwd");
			expect(canonicalizePath("C:/workspace/../other")).toBe("C:/other");
			expect(canonicalizePath("C:\\foo\\bar\\..\\baz")).toBe("C:/foo/baz");
		});

		it("detects null byte injection", () => {
			const res = validatePathWithinRoots("/workspace/file\0.txt", ["/workspace"]);
			expect(res.ok).toBe(false);
			expect(res.error).toContain("Null byte detected");
		});

		it("rejects path traversal attempting to escape workspace roots", () => {
			const res = validatePathWithinRoots("/workspace/repo/../../etc/shadow", ["/workspace/repo"]);
			expect(res.ok).toBe(false);
			expect(res.error).toContain("escapes allowed workspace roots");
		});

		it("rejects paths matching denied paths", () => {
			const res = validatePathWithinRoots(
				"/workspace/repo/.git/config",
				["/workspace/repo"],
				["/workspace/repo/.git"],
			);
			expect(res.ok).toBe(false);
			expect(res.error).toContain("resolves to denied path");
		});

		it("accepts valid paths strictly within allowed roots", () => {
			const res = validatePathWithinRoots(
				"/workspace/repo/src/index.ts",
				["/workspace/repo"],
				["/workspace/repo/.git"],
			);
			expect(res.ok).toBe(true);
			expect(res.canonicalPath).toBe("/workspace/repo/src/index.ts");
		});
	});

	describe("PlatformSandboxProvider Fail-Closed Behavior", () => {
		it("throws SandboxUnsupportedError in secure mode on unsupported platform without fallback", async () => {
			const provider = new PlatformSandboxProvider({
				platform: "unsupported",
				isSupported: false,
				sandboxMode: "secure",
			});

			expect(provider.isSupported).toBe(false);

			await expect(
				provider.evaluate({
					allowWorkspaceOnly: true,
					allowNetwork: false,
				}),
			).rejects.toThrow(SandboxUnsupportedError);

			await expect(
				provider.wrapCommand("ls", ["-la"], {
					allowWorkspaceOnly: true,
					allowNetwork: false,
				}),
			).rejects.toThrow(SandboxUnsupportedError);
		});

		it("allows command wrapping in trusted-local mode when explicitly chosen", async () => {
			const provider = new PlatformSandboxProvider({
				platform: "windows",
				isSupported: true,
				sandboxMode: "trusted-local",
			});

			const wrapped = await provider.wrapCommand("node", ["app.js"], {
				allowWorkspaceOnly: true,
				allowNetwork: false,
			});

			expect(wrapped.command).toBe("node");
			expect(wrapped.args).toEqual(["app.js"]);
		});
	});

	describe("ExecutionBroker Security Pipeline Integration", () => {
		const dummyContext = {
			toolAttemptId: asToolAttemptId("att_sec_1"),
			toolCallId: asToolCallId("call_sec_1"),
			turnId: asTurnId("turn_sec_1"),
			stepId: asStepId("step_sec_1"),
			signal: new AbortController().signal,
		};

		it("strictly denies execution when policy check denies (execute count === 0)", async () => {
			let executed = false;
			const broker = new ExecutionBrokerImpl({
				policyEngine: new DefaultPolicyEngine(),
				permissionProfile: {
					profileId: "deny_prof",
					commands: {
						allow: ["*"],
						deny: ["dangerous *"],
					},
				},
				supervisor: {
					spawn: async () => {
						executed = true;
						throw new Error("Should not be called");
					},
					read: async () => ({ chunks: [] }),
				} as any,
			});

			const outcome = await broker.executeAction(
				{
					kind: "process",
					toolName: "cli",
					payload: { command: "dangerous operation" },
				},
				dummyContext,
			);

			expect(outcome.status).toBe("denied");
			expect(executed).toBe(false);
		});

		it("strictly denies execution when approval is rejected (execute count === 0)", async () => {
			let executed = false;
			const approvalManager = new ApprovalManagerImpl();
			const broker = new ExecutionBrokerImpl({
				policyEngine: new DefaultPolicyEngine(),
				approvalManager,
				supervisor: {
					spawn: async () => {
						executed = true;
						throw new Error("Should not be called");
					},
					read: async () => ({ chunks: [] }),
				} as any,
			});

			// Tool "bash" requires approval by default in DefaultPolicyEngine
			const executePromise = broker.executeAction(
				{
					kind: "process",
					toolName: "bash",
					payload: { command: "git status" },
				},
				dummyContext,
			);

			// Wait for approval request to register
			await new Promise((r) => setTimeout(r, 20));
			expect(approvalManager.pendingCount).toBe(1);

			// Reject the approval
			const pendingReq = Array.from((approvalManager as any).pendingRequests.keys())[0] as string;
			approvalManager.resolve(pendingReq, "rejected");

			const outcome = await executePromise;
			expect(outcome.status).toBe("denied");
			expect(outcome.error).toContain("Approval resolution: rejected");
			expect(executed).toBe(false);
		});

		it("fails closed without execution when sandbox is unsupported in secure mode", async () => {
			let executed = false;
			const approvalManager = new ApprovalManagerImpl();
			const unsupportedSandbox = new PlatformSandboxProvider({
				platform: "unsupported",
				isSupported: false,
				sandboxMode: "secure",
			});

			const broker = new ExecutionBrokerImpl({
				policyEngine: new DefaultPolicyEngine(),
				approvalManager,
				sandboxProvider: unsupportedSandbox,
				supervisor: {
					spawn: async () => {
						executed = true;
						throw new Error("Should not be called");
					},
					read: async () => ({ chunks: [] }),
				} as any,
			});

			const executePromise = broker.executeAction(
				{
					kind: "process",
					toolName: "bash",
					payload: { command: "npm test" },
				},
				dummyContext,
			);

			await new Promise((r) => setTimeout(r, 20));
			const pendingReq = Array.from((approvalManager as any).pendingRequests.keys())[0] as string;
			approvalManager.resolve(pendingReq, "approved");

			const outcome = await executePromise;
			expect(outcome.status).toBe("failed");
			expect(outcome.error).toContain("sandbox enforcement is unsupported");
			expect(executed).toBe(false);
		});
	});
});
