import { describe, expect, it } from "vitest";
import { ExecutionBrokerImpl } from "../../src/runtime/adapters/execution-broker-impl.ts";
import { ApprovalManagerImpl } from "../../src/runtime/security/approval.ts";
import { DefaultPolicyEngine } from "../../src/runtime/security/policy.ts";
import type { PermissionProfile } from "../../src/runtime/security/types.ts";
import { MemoryWorkspaceFSProvider } from "../../src/runtime/security/workspace-fs.ts";
import { createBrokeredCodingTools } from "../../src/runtime/tools/brokered-coding-tools.ts";

describe("M8 Brokered Coding Tools & Policy/Approval Enforcement", () => {
	it("executes read, write, and edit tools through ExecutionBroker into WorkspaceFS", async () => {
		const workspaceFS = new MemoryWorkspaceFSProvider({
			"/workspace/hello.txt": "Hello Antigravity\nLine 2\nLine 3",
		});

		const broker = new ExecutionBrokerImpl({ workspaceFS });
		const tools = createBrokeredCodingTools({ broker });

		// 1. Read existing file
		const readRes = await tools.read.execute("call_read", { path: "/workspace/hello.txt" });
		expect((readRes.details as { content: string }).content).toContain("Hello Antigravity");

		// 2. Write new file
		const writeRes = await tools.write.execute("call_write", {
			path: "/workspace/new-file.ts",
			content: "export const x = 42;",
		});
		expect((writeRes.details as { written: boolean }).written).toBe(true);

		const readWritten = await tools.read.execute("call_read2", { path: "/workspace/new-file.ts" });
		expect((readWritten.details as { content: string }).content).toBe("export const x = 42;");

		// 3. Edit file atomically
		const editRes = await tools.edit.execute("call_edit", {
			path: "/workspace/new-file.ts",
			edits: [{ oldText: "42", newText: "100" }],
		});
		expect((editRes.details as { edited: boolean }).edited).toBe(true);

		const readEdited = await tools.read.execute("call_read3", { path: "/workspace/new-file.ts" });
		expect((readEdited.details as { content: string }).content).toBe("export const x = 100;");
	});

	it("enforces PolicyEngine filesystem boundary: denies writes outside allowed roots", async () => {
		const workspaceFS = new MemoryWorkspaceFSProvider({}, ["/workspace/project"]);
		const profile: PermissionProfile = {
			profileId: "test_fs_profile",
			filesystem: {
				readRoots: ["/workspace/project"],
				writeRoots: ["/workspace/project"],
			},
		};
		const policyEngine = new DefaultPolicyEngine();
		const broker = new ExecutionBrokerImpl({
			workspaceFS,
			policyEngine,
			permissionProfile: profile,
		});
		const tools = createBrokeredCodingTools({ broker });

		// Writing inside root succeeds
		const allowedWrite = await tools.write.execute("call_allowed", {
			path: "/workspace/project/main.ts",
			content: "console.log('safe');",
		});
		expect((allowedWrite.details as { written: boolean }).written).toBe(true);

		// Writing outside root is denied by policy
		await expect(
			tools.write.execute("call_denied", {
				path: "/etc/passwd",
				content: "malicious",
			}),
		).rejects.toThrow(/denied/i);
	});

	it("enforces ApprovalManager for privileged tools: resolves upon approval and rejects upon rejection", async () => {
		const approvalManager = new ApprovalManagerImpl();
		const policyEngine = new DefaultPolicyEngine();
		const profile: PermissionProfile = {
			profileId: "test_privileged_profile",
		};

		// Fake bash tool registered in broker
		const broker = new ExecutionBrokerImpl({
			policyEngine,
			permissionProfile: profile,
			approvalManager,
			tools: new Map([
				[
					"bash",
					{
						name: "bash",
						label: "bash",
						description: "Shell",
						parameters: {} as any,
						execute: async () => ({
							content: [{ type: "text" as const, text: "command succeeded\n" }],
							details: { stdout: "command succeeded\n", exitCode: 0 },
						}),
					},
				],
			]),
		});

		const tools = createBrokeredCodingTools({ broker });

		// 1. Auto-approve listener
		let approvalRequested = false;
		const sub1 = approvalManager.onRequest((req) => {
			approvalRequested = true;
			// Approve immediately
			approvalManager.resolve(req.requestId, "approved");
		});

		const res = await tools.bash.execute("call_bash", { command: "echo ok" });
		expect(approvalRequested).toBe(true);
		expect((res.details as { stdout: string }).stdout).toBe("command succeeded\n");

		// Dispose first listener so it doesn't approve the rejected test
		sub1.dispose();

		// 2. Reject listener
		approvalManager.onRequest((req) => {
			approvalManager.resolve(req.requestId, "rejected");
		});

		await expect(tools.bash.execute("call_bash_rejected", { command: "rm -rf /" })).rejects.toThrow(/denied/i);
	});
});
