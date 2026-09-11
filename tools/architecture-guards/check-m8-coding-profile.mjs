import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const requiredFiles = [
	"packages/agent/src/runtime/security/workspace-fs.ts",
	"packages/agent/src/runtime/tools/brokered-coding-tools.ts",
	"packages/agent/src/runtime/compaction/compactor.ts",
	"packages/agent/src/runtime/plugin/pi-extension-facade.ts",
	"packages/agent/src/runtime/composition/coding-profile.ts",
	"packages/agent/src/runtime/client/protocol-v2-client.ts",
	"packages/agent/test/runtime/coding-brokered-tools.test.ts",
	"packages/agent/test/runtime/compaction.test.ts",
	"packages/agent/test/runtime/coding-profile.test.ts",
];

const failures = [];

for (const relativePath of requiredFiles) {
	try {
		const content = await readFile(resolve(repositoryRoot, relativePath), "utf8");
		if (content.trim().length === 0) {
			failures.push(`${relativePath}: file is empty`);
		}

		// Architecture Rule: Brokered tools must strictly route via ExecutionBroker
		if (relativePath === "packages/agent/src/runtime/tools/brokered-coding-tools.ts") {
			if (
				!content.includes("options.broker.prepareAction") ||
				!content.includes("options.broker.executeAction")
			) {
				failures.push(`${relativePath}: tools must strictly dispatch effectful actions through ExecutionBroker`);
			}
			if (
				content.includes("node:fs") ||
				content.includes("node:child_process") ||
				content.includes("child_process")
			) {
				failures.push(`${relativePath}: brokered tools must not directly import or execute node:fs or child_process`);
			}
		}

		// Architecture Rule: WorkspaceFS root validation
		if (relativePath === "packages/agent/src/runtime/security/workspace-fs.ts") {
			if (
				!content.includes("validatePathWithinRoots") ||
				!content.includes("LocalWorkspaceFSProvider") ||
				!content.includes("MemoryWorkspaceFSProvider")
			) {
				failures.push(`${relativePath}: must validate all paths with validatePathWithinRoots and provide Local and Memory providers`);
			}
		}

		// Architecture Rule: Compaction engine must support journal fact creation
		if (relativePath === "packages/agent/src/runtime/compaction/compactor.ts") {
			if (
				!content.includes("shouldCompact") ||
				!content.includes("compact") ||
				!content.includes("createJournalFact")
			) {
				failures.push(`${relativePath}: must implement threshold checking, compaction, and journal fact creation`);
			}
		}

		// Architecture Rule: Coding profile composition must wire all core elements
		if (relativePath === "packages/agent/src/runtime/composition/coding-profile.ts") {
			if (
				!content.includes("ExecutionBrokerImpl") ||
				!content.includes("createBrokeredCodingTools") ||
				!content.includes("ProtocolV2Server") ||
				!content.includes("CompactionEngine")
			) {
				failures.push(`${relativePath}: must assemble ExecutionBrokerImpl, brokered tools, ProtocolV2Server, and CompactionEngine`);
			}
		}
	} catch (err) {
		failures.push(`${relativePath}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

if (failures.length > 0) {
	console.error("M8 Coding Profile & Product Migration Architecture Violations:\n" + failures.join("\n"));
	process.exitCode = 1;
} else {
	console.log(`M8 architecture Coding Profile & Migration OK (${requiredFiles.length} verified artifacts)`);
}
