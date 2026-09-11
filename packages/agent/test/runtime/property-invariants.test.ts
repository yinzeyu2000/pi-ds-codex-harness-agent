import {
	asClientRequestId,
	asControllerEpoch,
	asRuntimeGeneration,
	asStepId,
	asThreadId,
	asToolAttemptId,
	asToolCallId,
	asTurnId,
	type WireEventEnvelope,
} from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import {
	type AgentDriver,
	BaseRuntimeError,
	createServiceToken,
	type DriverRunOptions,
	type DriverRunResult,
	ExecutionBrokerImpl,
	FaultInjector,
	MemoryJournalWriter,
	type Plugin,
	PluginActivationError,
	PluginHost,
	ThreadRuntimeImpl,
	wrapBrokerWithFaultInjector,
} from "../../src/runtime/index.ts";
import type { ToolExecutionContext } from "../../src/runtime/types/execution-broker.ts";

class HangingDriver implements AgentDriver {
	readonly name = "HangingDriver";
	private resolveTurn?: (res: DriverRunResult) => void;

	async run(_options: DriverRunOptions): Promise<DriverRunResult> {
		return new Promise<DriverRunResult>((res) => {
			this.resolveTurn = res;
		});
	}

	finish(turnId: any): void {
		if (this.resolveTurn) {
			this.resolveTurn({ turnId, outcome: "completed" });
		}
	}
}

class RaceDriver implements AgentDriver {
	readonly name = "RaceDriver";
	private readonly delayMs: number;

	constructor(delayMs = 2) {
		this.delayMs = delayMs;
	}

	async run(options: DriverRunOptions): Promise<DriverRunResult> {
		if (this.delayMs > 0) {
			await new Promise((r) => setTimeout(r, this.delayMs));
		}
		if (options.signal.aborted) {
			return { turnId: options.turnId, outcome: "interrupted" };
		}
		return { turnId: options.turnId, outcome: "completed" };
	}
}

describe("M9 Reliability: State Machine Property Invariants", () => {
	it("Invariant 1 (Plugin Scope LIFO Rollback): failure during effect activation unrolls previous effects leaving 0 leaks", async () => {
		const host = new PluginHost();
		const TokenA = createServiceToken<{ value: string }>("service-a");
		const disposed: string[] = [];

		const p1: Plugin = {
			manifest: {
				id: "plugin-1",
				version: "1.0.0",
				provides: [{ id: "service-a" }],
			},
			activate: (ctx) => {
				ctx.provide(TokenA, { value: "a" });
				ctx.defer(() => {
					disposed.push("p1-disposed");
				});
			},
		};

		const p2: Plugin = {
			manifest: {
				id: "plugin-2",
				version: "1.0.0",
				requires: [{ id: "service-a" }],
			},
			activate: (ctx) => {
				ctx.defer(() => {
					disposed.push("p2-partial-disposed");
				});
				throw new Error("Deliberate plugin 2 failure");
			},
		};

		await expect(host.start([p1, p2])).rejects.toThrow(PluginActivationError);

		// Rollback must strictly dispose in LIFO order: p2 first, then p1
		expect(disposed).toEqual(["p2-partial-disposed", "p1-disposed"]);
		expect(host.activatedCount).toBe(0);
	});

	it("Invariant 2 (Terminal Exclusivity): concurrent interrupt and complete races settle with exactly one terminal outcome", async () => {
		const threadId = asThreadId("th_term_race_prop");
		const writer = new MemoryJournalWriter(threadId);
		const driver = new RaceDriver(3);
		const runtime = new ThreadRuntimeImpl(threadId, asRuntimeGeneration(1), writer, driver);
		const lease = await runtime.acquireController("ctrl-race");

		const emittedTerminals: WireEventEnvelope[] = [];
		runtime.subscribe((ev) => {
			if (ev.type === "turn.completed" || ev.type === "turn.interrupted" || ev.type === "turn.failed") {
				emittedTerminals.push(ev);
			}
		});

		const clientReqId = asClientRequestId("req_race_prop_1");
		const epoch = asControllerEpoch(lease.epoch);
		const turn = await runtime.startTurn("Race prompt", clientReqId, epoch, "user-race");

		// Concurrently trigger interrupt after slight delay
		await new Promise((r) => setTimeout(r, 2));
		void runtime.interruptTurn(turn.turnId, epoch, "Race interrupt");

		// Wait for turn to settle completely
		let retries = 0;
		while (runtime.activeTurn !== undefined && retries++ < 50) {
			await new Promise((r) => setTimeout(r, 10));
		}

		expect(runtime.activeTurn).toBeUndefined();
		// Invariant: Exactly one terminal wire event emitted
		expect(emittedTerminals.length).toBe(1);
		expect(["turn.completed", "turn.interrupted"]).toContain(emittedTerminals[0].type);
	});

	it("Invariant 3 (Durability Barrier): failure before execution dispatch guarantees 0 body executions", async () => {
		const injector = new FaultInjector();
		let bodyExecutions = 0;

		const broker = new ExecutionBrokerImpl({
			tools: new Map([
				[
					"dummy",
					{
						name: "dummy",
						label: "dummy",
						description: "dummy tool",
						parameters: {} as any,
						execute: async () => {
							bodyExecutions++;
							return { content: [{ type: "text" as const, text: "done" }], details: {} };
						},
					},
				],
			]),
		});

		// Wrap broker with fault injector
		wrapBrokerWithFaultInjector(broker, injector);

		// Inject failure right before execute
		injector.inject({
			point: "broker:before_execute",
			error: new Error("Disk full: write barrier failed"),
		});

		const context: ToolExecutionContext = {
			toolAttemptId: asToolAttemptId("att_1"),
			toolCallId: asToolCallId("call_1"),
			turnId: asTurnId("turn_1"),
			stepId: asStepId("step_1"),
			signal: new AbortController().signal,
		};

		const prepared = await broker.prepareAction("dummy", {}, context);
		const outcome = await broker.executeAction(prepared, context);

		expect(outcome.status).toBe("failed");
		expect(outcome.error).toMatch(/Disk full/);
		// Crucial safety invariant: body was NEVER called
		expect(bodyExecutions).toBe(0);
	});

	it("Invariant 4 (ActiveTurn Exclusivity): 50 concurrent turn requests admit at most 1 active turn", async () => {
		const threadId = asThreadId("th_excl_prop_50");
		const writer = new MemoryJournalWriter(threadId);
		const driver = new HangingDriver();
		const runtime = new ThreadRuntimeImpl(threadId, asRuntimeGeneration(1), writer, driver);
		const lease = await runtime.acquireController("ctrl-excl");
		const epoch = asControllerEpoch(lease.epoch);

		// Start Turn 1
		const turn1 = await runtime.startTurn("First active turn", asClientRequestId("req_root"), epoch, "user-1");

		expect(turn1.phase).toBe("admitted");
		expect(runtime.activeTurn?.turnId).toBe(turn1.turnId);

		// Concurrently attempt 50 turns while turn 1 is active
		let rejectedCount = 0;
		const promises: Promise<void>[] = [];

		for (let i = 0; i < 50; i++) {
			const reqId = asClientRequestId(`req_concurrent_${i}`);
			promises.push(
				runtime
					.startTurn(`Concurrent prompt ${i}`, reqId, epoch, "user-1")
					.then(() => {
						// Should not succeed
					})
					.catch((err) => {
						if (err instanceof BaseRuntimeError && err.code === "ACTIVE_TURN_CONFLICT") {
							rejectedCount++;
						}
					}),
			);
		}

		await Promise.all(promises);

		// All 50 concurrent turns were rejected due to ActiveTurn exclusivity
		expect(rejectedCount).toBe(50);
		expect(runtime.activeTurn?.turnId).toBe(turn1.turnId);

		// Complete turn 1 cleanly
		driver.finish(turn1.turnId);
		let retries = 0;
		while (runtime.activeTurn !== undefined && retries++ < 50) {
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(runtime.activeTurn).toBeUndefined();
	});
});
