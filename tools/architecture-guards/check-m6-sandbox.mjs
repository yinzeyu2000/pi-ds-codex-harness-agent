import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const requiredFiles = [
	"packages/agent/src/runtime/security/types.ts",
	"packages/agent/src/runtime/security/policy.ts",
	"packages/agent/src/runtime/security/approval.ts",
	"packages/agent/src/runtime/security/sandbox-provider.ts",
	"packages/agent/src/runtime/security/index.ts",
	"packages/agent/src/runtime/adapters/execution-broker-impl.ts",
	"packages/agent/test/runtime/security-policy-intersection.test.ts",
	"packages/agent/test/runtime/security-approval-lifecycle.test.ts",
	"packages/agent/test/runtime/security-sandbox-isolation.test.ts",
	"packages/agent/test/runtime/sandbox-contracts.test.ts",
];

const failures = [];

for (const relativePath of requiredFiles) {
	try {
		const content = await readFile(resolve(repositoryRoot, relativePath), "utf8");
		if (content.trim().length === 0) {
			failures.push(`${relativePath}: file is empty`);
		}

		// Architecture Rule: Browser safety - security modules must not import node:net, node:child_process, node:fs
		if (relativePath.startsWith("packages/agent/src/runtime/security/")) {
			if (
				content.includes("node:net") ||
				content.includes("node:child_process") ||
				content.includes("node:fs")
			) {
				failures.push(`${relativePath}: security core module must remain browser-safe (no node:net, node:child_process, node:fs)`);
			}
		}

		// Architecture Rule: Monotonic policy intersection and resource limits
		if (relativePath === "packages/agent/src/runtime/security/policy.ts") {
			if (
				!content.includes("intersectPermissionProfiles") ||
				!content.includes("intersectResourceLimits") ||
				!content.includes("freezeExecutionEnvironment")
			) {
				failures.push(`${relativePath}: missing intersectPermissionProfiles, intersectResourceLimits, or freezeExecutionEnvironment`);
			}
		}

		// Architecture Rule: Approval fingerprint and TOCTOU secondary validation
		if (relativePath === "packages/agent/src/runtime/security/approval.ts") {
			if (
				!content.includes("computeApprovalFingerprint") ||
				!content.includes("cancelAllForThread") ||
				!content.includes("verifyPreExecutionFingerprint")
			) {
				failures.push(`${relativePath}: missing computeApprovalFingerprint, cancelAllForThread, or verifyPreExecutionFingerprint`);
			}
		}

		// Architecture Rule: Path traversal protection and fail-closed sandbox
		if (relativePath === "packages/agent/src/runtime/security/sandbox-provider.ts") {
			if (
				!content.includes("validatePathWithinRoots") ||
				!content.includes("canonicalizePath") ||
				!content.includes("SandboxUnsupportedError")
			) {
				failures.push(`${relativePath}: missing validatePathWithinRoots, canonicalizePath, or SandboxUnsupportedError fail-closed`);
			}
		}

		// Architecture Rule: ExecutionBroker security pipeline wiring
		if (relativePath === "packages/agent/src/runtime/adapters/execution-broker-impl.ts") {
			if (
				!content.includes("policyEngine") ||
				!content.includes("approvalManager") ||
				!content.includes("sandboxProvider") ||
				!content.includes("computeApprovalFingerprint")
			) {
				failures.push(`${relativePath}: missing policyEngine, approvalManager, sandboxProvider, or fingerprint verification`);
			}
		}
	} catch (err) {
		failures.push(`${relativePath}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

if (failures.length > 0) {
	console.error("M6 Policy & Sandbox Architecture Violations:\n" + failures.join("\n"));
	process.exitCode = 1;
} else {
	console.log(`M6 architecture Policy & Sandbox OK (${requiredFiles.length} verified artifacts)`);
}
