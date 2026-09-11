import {
	asEventId,
	type ServerMessageV2,
	type ThreadId,
	type ThreadWatchResult,
	type WireEventEnvelope,
	type WireEventType,
} from "@earendil-works/pi-protocol";
import type { ThreadRuntimeImpl } from "../thread/thread-runtime-impl.ts";
import type { JournalEnvelope, ThreadJournalStore } from "../types/journal.ts";
import type { ThreadRuntime } from "../types/thread-runtime.ts";

export interface WatcherSubscription {
	readonly connectionId: string;
	readonly threadId: ThreadId;
	readonly dispose: () => void;
}

export class DurableWatchManager {
	private readonly journalStore?: ThreadJournalStore;
	private readonly subscriptions = new Map<string, Set<WatcherSubscription>>();

	constructor(journalStore?: ThreadJournalStore) {
		this.journalStore = journalStore;
	}

	async watch(
		connectionId: string,
		threadId: ThreadId,
		runtime: ThreadRuntime,
		afterSeq: number | undefined,
		send: (message: ServerMessageV2) => Promise<boolean>,
	): Promise<ThreadWatchResult> {
		const snapshot = await runtime.getSnapshot();
		const durableWatermarkSeq = snapshot.durableWatermarkSeq ?? 0;

		// 1. Replay historical events if requested and behind watermark
		if (afterSeq !== undefined && afterSeq < durableWatermarkSeq) {
			await this.replayHistoricalEvents(threadId, runtime, afterSeq, durableWatermarkSeq, send);
		}

		// 2. Register for live/future WireEvents
		const runtimeImpl = runtime as ThreadRuntimeImpl;
		const sub = runtimeImpl.subscribe((wireEvent) => {
			void send({
				type: "event",
				event: wireEvent,
			});
		});

		const watcherSub: WatcherSubscription = {
			connectionId,
			threadId,
			dispose: sub.dispose,
		};

		let set = this.subscriptions.get(connectionId);
		if (!set) {
			set = new Set();
			this.subscriptions.set(connectionId, set);
		}
		set.add(watcherSub);

		return {
			command: "thread/watch",
			threadId,
			snapshot,
			durableWatermarkSeq,
		};
	}

	private async replayHistoricalEvents(
		threadId: ThreadId,
		runtime: ThreadRuntime,
		afterSeq: number,
		durableWatermarkSeq: number,
		send: (message: ServerMessageV2) => Promise<boolean>,
	): Promise<void> {
		const envelopes: JournalEnvelope[] = [];

		if (this.journalStore) {
			try {
				for await (const env of this.journalStore.load(threadId, afterSeq)) {
					if (env.seq > afterSeq && env.seq <= durableWatermarkSeq) {
						envelopes.push(env);
					}
				}
			} catch {
				// Fall back to runtime journal writer if store load failed
			}
		}

		if (envelopes.length === 0) {
			const committed = (runtime.journalWriter as { committedEnvelopes?: JournalEnvelope[] }).committedEnvelopes;
			if (committed && Array.isArray(committed)) {
				for (const env of committed) {
					if (env.seq > afterSeq && env.seq <= durableWatermarkSeq) {
						envelopes.push(env);
					}
				}
			}
		}

		for (const env of envelopes) {
			const wireEvent = this.envelopeToWireEvent(env);
			if (wireEvent) {
				await send({
					type: "event",
					event: wireEvent,
				});
			}
		}
	}

	private envelopeToWireEvent(env: JournalEnvelope): WireEventEnvelope | undefined {
		const record = env.record;
		let type: WireEventType | undefined;
		let payload: unknown = record;

		if (record.recordType === "runtime_fact") {
			const fact = record.fact;
			if (fact.factType === "turn") {
				if (fact.status === "admitted") type = "turn.admitted";
				else if (fact.status === "started") type = "turn.started";
				else if (fact.status === "completed") type = "turn.completed";
				else if (fact.status === "interrupted") type = "turn.interrupted";
				else if (fact.status === "failed") type = "turn.failed";
				payload = { turnId: fact.turnId, status: fact.status, error: fact.error };
			} else if (fact.factType === "step") {
				if (fact.status === "started") type = "step.started";
				else if (fact.status === "completed") type = "step.completed";
				payload = { stepId: fact.stepId, turnId: fact.turnId, stepIndex: fact.stepIndex };
			} else if (fact.factType === "tool_attempt") {
				if (fact.status === "attempt_prepared" || fact.status === "execution_started") {
					type = "tool_attempt.started";
				} else {
					type = "tool_attempt.completed";
				}
				payload = { toolAttemptId: fact.toolAttemptId, status: fact.status, error: fact.error };
			} else if (fact.factType === "approval") {
				type = "approval.resolved";
				payload = { requestId: fact.requestId, decision: fact.decision };
			} else if (fact.factType === "process") {
				if (fact.status === "starting" || fact.status === "running") {
					type = "process.started";
				} else {
					type = "process.ended";
				}
				payload = { processId: fact.processId, status: fact.status, exitCode: fact.exitCode };
			}
		} else if (record.recordType === "entry") {
			type = "item.completed";
			payload = { entry: record.entry };
		}

		if (!type) return undefined;

		return {
			eventId: env.eventId ?? asEventId(`evt_${env.seq}`),
			threadId: env.threadId,
			seq: env.seq,
			type,
			payload,
			timestamp: env.timestamp,
		};
	}

	unwatch(connectionId: string, threadId?: ThreadId): void {
		const set = this.subscriptions.get(connectionId);
		if (!set) return;

		for (const sub of Array.from(set)) {
			if (!threadId || sub.threadId === threadId) {
				sub.dispose();
				set.delete(sub);
			}
		}

		if (set.size === 0) {
			this.subscriptions.delete(connectionId);
		}
	}

	dispose(): void {
		for (const set of this.subscriptions.values()) {
			for (const sub of set) {
				sub.dispose();
			}
		}
		this.subscriptions.clear();
	}
}
