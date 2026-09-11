import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const requiredFiles = [
	"packages/agent/src/runtime/server/index.ts",
	"packages/agent/src/runtime/server/controller-lease-manager.ts",
	"packages/agent/src/runtime/server/deduplicator.ts",
	"packages/agent/src/runtime/server/durable-watch-manager.ts",
	"packages/agent/src/runtime/server/protocol-v2-server.ts",
	"packages/agent/src/runtime/server/transports/types.ts",
	"packages/agent/src/runtime/server/transports/bounded-outbound-queue.ts",
	"packages/agent/src/runtime/server/transports/stdio-transport.ts",
	"packages/agent/src/runtime/server/transports/ipc-transport.ts",
	"packages/agent/test/runtime/protocol-v2-handshake.test.ts",
	"packages/agent/test/runtime/protocol-v2-controller-fencing.test.ts",
	"packages/agent/test/runtime/protocol-v2-deduplication.test.ts",
	"packages/agent/test/runtime/protocol-v2-watch-cursors.test.ts",
	"packages/agent/test/runtime/protocol-v2-transports.test.ts",
];

const failures = [];

for (const relativePath of requiredFiles) {
	try {
		const content = await readFile(resolve(repositoryRoot, relativePath), "utf8");
		if (content.trim().length === 0) {
			failures.push(`${relativePath}: file is empty`);
		}

		// Architecture Rule: Browser safety - server kernel modules must not import node:net, node:fs, node:child_process
		if (
			relativePath === "packages/agent/src/runtime/server/controller-lease-manager.ts" ||
			relativePath === "packages/agent/src/runtime/server/deduplicator.ts" ||
			relativePath === "packages/agent/src/runtime/server/durable-watch-manager.ts" ||
			relativePath === "packages/agent/src/runtime/server/protocol-v2-server.ts" ||
			relativePath === "packages/agent/src/runtime/server/transports/bounded-outbound-queue.ts"
		) {
			if (
				content.includes("node:net") ||
				content.includes("node:child_process") ||
				content.includes("node:fs")
			) {
				failures.push(`${relativePath}: server core module must remain browser-safe (no node:net, node:child_process, node:fs)`);
			}
		}

		// Architecture Rule: Controller lease manager must maintain monotonic ControllerEpoch and epoch validation
		if (relativePath === "packages/agent/src/runtime/server/controller-lease-manager.ts") {
			if (!content.includes("validateEpoch") || !content.includes("ControllerEpoch") || !content.includes("epochCounters")) {
				failures.push(`${relativePath}: missing monotonic ControllerEpoch progression or validateEpoch`);
			}
		}

		// Architecture Rule: Command deduplicator must enforce conflict checking, LRU eviction, and payload hashing
		if (relativePath === "packages/agent/src/runtime/server/deduplicator.ts") {
			if (
				!content.includes("CommandDeduplicationConflictError") ||
				!content.includes("computePayloadHash") ||
				!content.includes("maxEntries")
			) {
				failures.push(`${relativePath}: missing deduplication conflict error, payload hashing, or LRU cap`);
			}
		}

		// Architecture Rule: Durable watch manager must support historical replay up to watermark
		if (relativePath === "packages/agent/src/runtime/server/durable-watch-manager.ts") {
			if (!content.includes("durableWatermarkSeq") || !content.includes("replayHistoricalEvents")) {
				failures.push(`${relativePath}: must support historical journal catchup up to durableWatermarkSeq`);
			}
		}

		// Architecture Rule: Protocol v2 server must validate 3-way handshake and enforce fencing
		if (relativePath === "packages/agent/src/runtime/server/protocol-v2-server.ts") {
			if (!content.includes("ServerHelloV2") || !content.includes("initialized") || !content.includes("validateEpoch")) {
				failures.push(`${relativePath}: must implement 3-way handshake and validateEpoch controller fencing`);
			}
		}
	} catch (err) {
		failures.push(`${relativePath}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

if (failures.length > 0) {
	console.error("M7a Protocol Architecture Violations:\n" + failures.join("\n"));
	process.exitCode = 1;
} else {
	console.log(`M7a architecture Protocol v2 OK (${requiredFiles.length} verified artifacts)`);
}
