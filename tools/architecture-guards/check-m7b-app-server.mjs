import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const requiredFiles = [
	"packages/agent/src/runtime/client/diagnostic-client.ts",
	"packages/agent/src/runtime/server/protocol-v2-server.ts",
	"packages/agent/src/runtime/security/approval.ts",
	"packages/agent/test/runtime/protocol-v2-approval-integration.test.ts",
	"packages/agent/test/runtime/protocol-v2-multi-ui.test.ts",
];

const failures = [];

for (const relativePath of requiredFiles) {
	try {
		const content = await readFile(resolve(repositoryRoot, relativePath), "utf8");
		if (content.trim().length === 0) {
			failures.push(`${relativePath}: file is empty`);
		}

		// Architecture Rule: Browser safety - client must not import node:net, node:child_process, node:fs
		if (relativePath === "packages/agent/src/runtime/client/diagnostic-client.ts") {
			if (
				content.includes("node:net") ||
				content.includes("node:child_process") ||
				content.includes("node:fs")
			) {
				failures.push(`${relativePath}: client core module must remain browser-safe (no node:net, node:child_process, node:fs)`);
			}
		}

		// Architecture Rule: Server approval integration & controller fencing
		if (relativePath === "packages/agent/src/runtime/server/protocol-v2-server.ts") {
			if (
				!content.includes("approvalManager") ||
				!content.includes("setupApprovalBroadcaster") ||
				!content.includes("approval.requested") ||
				!content.includes("approval.resolved") ||
				!content.includes("onAnyLeaseRevoked")
			) {
				failures.push(`${relativePath}: must implement approvalManager integration, event broadcasting, and onAnyLeaseRevoked fail-closed cancel`);
			}
		}

		// Architecture Rule: Diagnostic client comprehensive protocol coverage
		if (relativePath === "packages/agent/src/runtime/client/diagnostic-client.ts") {
			if (
				!content.includes("handshake") ||
				!content.includes("acquireController") ||
				!content.includes("releaseController") ||
				!content.includes("watchThread") ||
				!content.includes("startTurn") ||
				!content.includes("respondApproval")
			) {
				failures.push(`${relativePath}: must implement complete DiagnosticClient Protocol v2 API`);
			}
		}
	} catch (err) {
		failures.push(`${relativePath}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

if (failures.length > 0) {
	console.error("M7b App Server & Multi-UI Architecture Violations:\n" + failures.join("\n"));
	process.exitCode = 1;
} else {
	console.log(`M7b architecture App Server & Multi-UI OK (${requiredFiles.length} verified artifacts)`);
}
