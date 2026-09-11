import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const requiredFiles = [
	"packages/agent/src/runtime/reliability/fault-injector.ts",
	"packages/agent/test/runtime/property-invariants.test.ts",
	"packages/agent/test/runtime/protocol-fuzz.test.ts",
	"packages/agent/test/runtime/soak-cancellation.test.ts",
	"docs/RUNBOOK_AND_RECOVERY.md",
	"docs/milestones/M9_STATUS.md",
];

const failures = [];

for (const relativePath of requiredFiles) {
	try {
		const content = await readFile(resolve(repositoryRoot, relativePath), "utf8");
		if (content.trim().length === 0) {
			failures.push(`${relativePath}: file is empty`);
		}

		// Architecture Rule: FaultInjector points and hooks
		if (relativePath === "packages/agent/src/runtime/reliability/fault-injector.ts") {
			if (
				!content.includes("FaultInjector") ||
				!content.includes("wrapBrokerWithFaultInjector") ||
				!content.includes("maybeTrigger")
			) {
				failures.push(`${relativePath}: must provide FaultInjector and wrapBrokerWithFaultInjector`);
			}
		}

		// Architecture Rule: State Machine Invariants
		if (relativePath === "packages/agent/test/runtime/property-invariants.test.ts") {
			if (
				!content.includes("Invariant 1") ||
				!content.includes("Invariant 2") ||
				!content.includes("Invariant 3") ||
				!content.includes("Invariant 4")
			) {
				failures.push(`${relativePath}: must test Invariants 1 through 4`);
			}
		}

		// Architecture Rule: Protocol Fuzzing
		if (relativePath === "packages/agent/test/runtime/protocol-fuzz.test.ts") {
			if (
				!content.includes("controller lease") ||
				!content.includes("duplicate clientRequestId") ||
				!content.includes("slow observer")
			) {
				failures.push(`${relativePath}: must verify controller fencing, deduplication, and slow observer isolation`);
			}
		}

		// Architecture Rule: Long soak simulation
		if (relativePath === "packages/agent/test/runtime/soak-cancellation.test.ts") {
			if (!content.includes("SoakDriver") || !content.includes("turn.interrupted")) {
				failures.push(`${relativePath}: must implement soak simulation with interruption verification`);
			}
		}

		// Architecture Rule: Operational Runbook
		if (relativePath === "docs/RUNBOOK_AND_RECOVERY.md") {
			if (!content.includes("Seven Invariant Uniques") || !content.includes("Torn-Tail")) {
				failures.push(`${relativePath}: must document invariant guarantees and torn-tail recovery procedures`);
			}
		}
	} catch (err) {
		failures.push(`${relativePath}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

if (failures.length > 0) {
	console.error("M9 Reliability & Stabilization Architecture Violations:\n" + failures.join("\n"));
	process.exitCode = 1;
} else {
	console.log(`M9 architecture Reliability & Stabilization OK (${requiredFiles.length} verified artifacts)`);
}
