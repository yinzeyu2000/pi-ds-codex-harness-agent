import { describe, expect, it } from "vitest";
import {
	DefaultPolicyEngine,
	freezeExecutionEnvironment,
	intersectPermissionProfiles,
	intersectResourceLimits,
	isSubpathOrEqual,
	matchesPattern,
	normalizePathSeparators,
	type PermissionProfile,
	type ResourceLimits,
} from "../../src/runtime/index.ts";

describe("M6 Security Policy & Monotonic Intersection", () => {
	describe("Path and Pattern Utilities", () => {
		it("normalizes path separators and trailing slashes", () => {
			expect(normalizePathSeparators("C:\\foo\\bar\\")).toBe("C:/foo/bar");
			expect(normalizePathSeparators("/usr/local/bin/")).toBe("/usr/local/bin");
			expect(normalizePathSeparators("/")).toBe("/");
		});

		it("correctly identifies subpath relationships", () => {
			expect(isSubpathOrEqual("/workspace/repo/src", "/workspace/repo")).toBe(true);
			expect(isSubpathOrEqual("/workspace/repo", "/workspace/repo")).toBe(true);
			expect(isSubpathOrEqual("/workspace/other", "/workspace/repo")).toBe(false);
			expect(isSubpathOrEqual("C:/Users/app/data", "c:\\users\\app")).toBe(true);
		});

		it("matches glob wildcard patterns", () => {
			expect(matchesPattern("git status", "git *")).toBe(true);
			expect(matchesPattern("rm -rf /tmp/foo", "rm -rf *")).toBe(true);
			expect(matchesPattern("npm test", "npm run *")).toBe(false);
			expect(matchesPattern("anything", "*")).toBe(true);
		});
	});

	describe("PermissionProfile Intersection", () => {
		it("enforces deny-always-wins and narrows allow list for commands", () => {
			const p1: PermissionProfile = {
				profileId: "p1",
				commands: {
					allow: ["git *", "npm *", "cargo *"],
					deny: ["rm *"],
				},
			};

			const p2: PermissionProfile = {
				profileId: "p2",
				commands: {
					allow: ["npm *", "cargo *", "python *"],
					deny: ["sudo *", "dd *"],
				},
			};

			const merged = intersectPermissionProfiles(p1, p2);
			expect(merged.commands?.allow).toEqual(["npm *", "cargo *"]);
			expect(merged.commands?.deny).toContain("rm *");
			expect(merged.commands?.deny).toContain("sudo *");
			expect(merged.commands?.deny).toContain("dd *");
		});

		it("narrows filesystem roots to subpaths and unions denied paths", () => {
			const p1: PermissionProfile = {
				profileId: "p1",
				filesystem: {
					readRoots: ["/workspace"],
					writeRoots: ["/workspace/build"],
					deniedPaths: ["/workspace/.env"],
				},
			};

			const p2: PermissionProfile = {
				profileId: "p2",
				filesystem: {
					readRoots: ["/workspace/src", "/other"],
					writeRoots: ["/workspace/build/dist"],
					deniedPaths: ["/workspace/secrets"],
				},
			};

			const merged = intersectPermissionProfiles(p1, p2);
			// Intersection of /workspace and /workspace/src is /workspace/src
			expect(merged.filesystem?.readRoots).toContain("/workspace/src");
			expect(merged.filesystem?.readRoots).not.toContain("/other");
			// Intersection of /workspace/build and /workspace/build/dist is /workspace/build/dist
			expect(merged.filesystem?.writeRoots).toEqual(["/workspace/build/dist"]);
			// Union of denied paths
			expect(merged.filesystem?.deniedPaths).toContain("/workspace/.env");
			expect(merged.filesystem?.deniedPaths).toContain("/workspace/secrets");
		});

		it("enforces that network access requires both profiles to allow", () => {
			const p1: PermissionProfile = {
				profileId: "p1",
				network: {
					allowNetwork: true,
					allowedHosts: ["api.github.com", "npm.org"],
					allowUnixSockets: true,
				},
			};

			const p2: PermissionProfile = {
				profileId: "p2",
				network: {
					allowNetwork: true,
					allowedHosts: ["api.github.com", "google.com"],
					allowUnixSockets: false,
				},
			};

			const merged = intersectPermissionProfiles(p1, p2);
			expect(merged.network?.allowNetwork).toBe(true);
			expect(merged.network?.allowedHosts).toEqual(["api.github.com"]);
			expect(merged.network?.allowUnixSockets).toBe(false);

			// If p3 denies network, result must deny
			const p3: PermissionProfile = {
				profileId: "p3",
				network: { allowNetwork: false },
			};
			const mergedDeny = intersectPermissionProfiles(p1, p3);
			expect(mergedDeny.network?.allowNetwork).toBe(false);
		});
	});

	describe("ResourceLimits Intersection", () => {
		it("always takes the minimum defined limit", () => {
			const r1: ResourceLimits = {
				timeoutMs: 30000,
				maxMemoryBytes: 1024 * 1024 * 1024,
				maxProcesses: 10,
			};

			const r2: ResourceLimits = {
				timeoutMs: 15000,
				maxMemoryBytes: 2 * 1024 * 1024 * 1024,
				maxProcesses: 5,
				maxOutputBytes: 1024 * 1024,
			};

			const merged = intersectResourceLimits(r1, r2);
			expect(merged.timeoutMs).toBe(15000);
			expect(merged.maxMemoryBytes).toBe(1024 * 1024 * 1024);
			expect(merged.maxProcesses).toBe(5);
			expect(merged.maxOutputBytes).toBe(1024 * 1024);
		});
	});

	describe("ExecutionEnvironment Freezing", () => {
		it("forbids downgrading sandbox security mode", () => {
			const base = {
				program: "node",
				args: ["app.js"],
				cwd: "/workspace",
				sandboxMode: "secure" as const,
			};

			expect(() => freezeExecutionEnvironment(base, { sandboxMode: "trusted-local" })).toThrow(
				/Cannot downgrade sandboxMode/,
			);
		});

		it("only allows narrowing the env allowlist", () => {
			const base = {
				program: "node",
				args: [],
				cwd: "/workspace",
				envAllowlist: ["NODE_ENV", "PATH", "HOME"],
				sandboxMode: "trusted-local" as const,
			};

			const narrowed = freezeExecutionEnvironment(base, {
				envAllowlist: ["PATH", "HOME", "EXTRA_SECRET"],
			});

			// EXTRA_SECRET was not in base, so it cannot be granted
			expect(narrowed.envAllowlist).toEqual(["PATH", "HOME"]);
		});
	});

	describe("DefaultPolicyEngine", () => {
		const engine = new DefaultPolicyEngine();

		it("requires approval for privileged shell tools", async () => {
			const decision = await engine.evaluate({
				action: { kind: "process", toolName: "bash", payload: { command: "ls" } },
				executionContext: {
					toolAttemptId: "att_1" as any,
					toolCallId: "call_1" as any,
					turnId: "turn_1" as any,
					stepId: "step_1" as any,
					signal: new AbortController().signal,
				},
			});

			expect(decision.decision).toBe("requires_approval");
		});

		it("denies commands matching profile deny list", async () => {
			const profile: PermissionProfile = {
				profileId: "test_prof",
				commands: {
					allow: ["*"],
					deny: ["rm -rf *", "mkfs *"],
				},
			};

			const decision = await engine.evaluate({
				action: { kind: "process", toolName: "shell", payload: { command: "rm -rf /" } },
				profile,
				executionContext: {
					toolAttemptId: "att_1" as any,
					toolCallId: "call_1" as any,
					turnId: "turn_1" as any,
					stepId: "step_1" as any,
					signal: new AbortController().signal,
				},
			});
			expect(decision.decision).toBe("requires_approval");

			// Test a non-shell process tool directly matching deny list
			const nonShellDecision = await engine.evaluate({
				action: { kind: "process", toolName: "git_runner", payload: { command: "rm -rf /" } },
				profile,
				executionContext: {
					toolAttemptId: "att_1" as any,
					toolCallId: "call_1" as any,
					turnId: "turn_1" as any,
					stepId: "step_1" as any,
					signal: new AbortController().signal,
				},
			});

			expect(nonShellDecision.decision).toBe("deny");
			if (nonShellDecision.decision === "deny") {
				expect(nonShellDecision.reason).toContain("matches denied pattern");
			}
		});

		it("denies filesystem actions outside allowed roots or matching denied paths", async () => {
			const profile: PermissionProfile = {
				profileId: "test_fs",
				filesystem: {
					readRoots: ["/workspace"],
					writeRoots: ["/workspace/output"],
					deniedPaths: ["/workspace/secret.key"],
				},
			};

			const dummyContext = {
				toolAttemptId: "att_1" as any,
				toolCallId: "call_1" as any,
				turnId: "turn_1" as any,
				stepId: "step_1" as any,
				signal: new AbortController().signal,
			};

			// Denied path
			const deniedRes = await engine.evaluate({
				action: { kind: "fs_read", toolName: "read_file", payload: {}, paths: ["/workspace/secret.key"] },
				profile,
				executionContext: dummyContext,
			});
			expect(deniedRes.decision).toBe("deny");

			// Outside read root
			const outsideReadRes = await engine.evaluate({
				action: { kind: "fs_read", toolName: "read_file", payload: {}, paths: ["/etc/shadow"] },
				profile,
				executionContext: dummyContext,
			});
			expect(outsideReadRes.decision).toBe("deny");

			// Inside allowed read root
			const validReadRes = await engine.evaluate({
				action: { kind: "fs_read", toolName: "read_file", payload: {}, paths: ["/workspace/src/index.ts"] },
				profile,
				executionContext: dummyContext,
			});
			expect(validReadRes.decision).toBe("allow");

			// Outside write root
			const invalidWriteRes = await engine.evaluate({
				action: { kind: "fs_write", toolName: "write_file", payload: {}, paths: ["/workspace/src/hacked.ts"] },
				profile,
				executionContext: dummyContext,
			});
			expect(invalidWriteRes.decision).toBe("deny");

			// Inside allowed write root
			const validWriteRes = await engine.evaluate({
				action: { kind: "fs_write", toolName: "write_file", payload: {}, paths: ["/workspace/output/bundle.js"] },
				profile,
				executionContext: dummyContext,
			});
			expect(validWriteRes.decision).toBe("allow");
		});
	});
});
