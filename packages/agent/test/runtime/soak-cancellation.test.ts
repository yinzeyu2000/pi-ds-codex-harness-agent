import {
	asClientRequestId,
	asControllerEpoch,
	asRuntimeGeneration,
	asThreadId,
	type WireEventEnvelope,
} from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import {
	type AgentDriver,
	type DriverRunOptions,
	type DriverRunResult,
	MemoryJournalWriter,
	ThreadRuntimeImpl,
} from "../../src/runtime/index.ts";

class SoakDriver implements AgentDriver {
	readonly name = "SoakDriver";

	async run(options: DriverRunOptions): Promise<DriverRunResult> {
		// Simulate work loop that responds to abort signal
		for (let i = 0; i < 5; i++) {
			if (options.signal.aborted) {
				return { turnId: options.turnId, outcome: "interrupted" };
			}
			await new Promise((r) => setTimeout(r, 4));
		}
		if (options.signal.aborted) {
			return { turnId: options.turnId, outcome: "interrupted" };
		}
		return { turnId: options.turnId, outcome: "completed" };
	}
}

describe("M9 Reliability: Long Soak & Randomized Cancellation", () => {
	it("executes 40 rapid sequential turns with 30% randomized cancellation without state bifurcation", async () => {
		const threadId = asThreadId("th_soak_40_turns");
		const writer = new MemoryJournalWriter(threadId);
		const driver = new SoakDriver();
		const runtime = new ThreadRuntimeImpl(threadId, asRuntimeGeneration(1), writer, driver);

		const lease = await runtime.acquireController("ctrl-soak");
		const epoch = asControllerEpoch(lease.epoch);
		const TOTAL_TURNS = 40;
		let completedCount = 0;
		let interruptedCount = 0;

		for (let i = 0; i < TOTAL_TURNS; i++) {
			const shouldCancel = i % 3 === 0;
			const clientReqId = asClientRequestId(`req_soak_${i}`);

			const termEvents: WireEventEnvelope[] = [];
			const sub = runtime.subscribe((ev) => {
				if (ev.type === "turn.completed" || ev.type === "turn.interrupted" || ev.type === "turn.failed") {
					termEvents.push(ev);
				}
			});

			const turn = await runtime.startTurn(`Soak prompt ${i}`, clientReqId, epoch, "user-soak");

			if (shouldCancel) {
				// Inject jittered cancellation
				const delay = 1 + (i % 6);
				setTimeout(() => {
					void runtime.interruptTurn(turn.turnId, epoch, "Deliberate soak interrupt");
				}, delay);
			}

			// Wait for turn settlement
			let retries = 0;
			while (runtime.activeTurn !== undefined && retries++ < 50) {
				await new Promise((r) => setTimeout(r, 5));
			}

			sub.dispose();

			// Invariant: runtime must be cleanly settled
			expect(runtime.activeTurn).toBeUndefined();
			expect(termEvents.length).toBe(1);

			if (termEvents[0].type === "turn.completed") {
				completedCount++;
			} else if (termEvents[0].type === "turn.interrupted") {
				interruptedCount++;
			}
		}

		// Ensure both completed and interrupted states were experienced cleanly
		expect(completedCount).toBeGreaterThan(15);
		expect(interruptedCount).toBeGreaterThan(8);
		expect(completedCount + interruptedCount).toBe(TOTAL_TURNS);

		// Post-soak health verification: fresh turn runs to completion
		const finalReqId = asClientRequestId("req_soak_final");
		await runtime.startTurn("Final post-soak turn", finalReqId, epoch, "user-soak");
		let retries = 0;
		while (runtime.activeTurn !== undefined && retries++ < 50) {
			await new Promise((r) => setTimeout(r, 5));
		}
		expect(runtime.activeTurn).toBeUndefined();
	});
});
