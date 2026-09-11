import { asItemId, asTurnId, type ItemSnapshot, type ThreadId, type TurnId } from "@earendil-works/pi-protocol";

export interface CompactionConfig {
	readonly maxTurns?: number;
	readonly maxItems?: number;
	readonly maxTokens?: number;
	readonly keepRecentTurns?: number;
	readonly summarizer?: (items: readonly ItemSnapshot[]) => Promise<string>;
}

export interface RuntimeCompactionResult {
	readonly compacted: boolean;
	readonly turnsCompacted: number;
	readonly itemsCompacted: number;
	readonly summaryText?: string;
	readonly summaryItem?: ItemSnapshot;
	readonly remainingItems: readonly ItemSnapshot[];
}

export interface CompactionJournalFact {
	readonly kind: "thread_compacted";
	readonly threadId: ThreadId;
	readonly compactedUpToTurnId: TurnId;
	readonly turnsCompacted: number;
	readonly itemsCompacted: number;
	readonly summaryText: string;
	readonly timestamp: number;
}

export class CompactionEngine {
	readonly config: CompactionConfig;

	constructor(config: CompactionConfig = {}) {
		this.config = {
			maxTurns: config.maxTurns ?? 10,
			maxItems: config.maxItems ?? 30,
			maxTokens: config.maxTokens ?? 32000,
			keepRecentTurns: config.keepRecentTurns ?? 2,
			summarizer: config.summarizer ?? defaultSummarizer,
		};
	}

	shouldCompact(turnCount: number, itemCount?: number, estimatedTokens?: number): boolean {
		if (this.config.maxTurns !== undefined && turnCount >= this.config.maxTurns) {
			return true;
		}
		if (this.config.maxItems !== undefined && itemCount !== undefined && itemCount >= this.config.maxItems) {
			return true;
		}
		if (
			this.config.maxTokens !== undefined &&
			estimatedTokens !== undefined &&
			estimatedTokens >= this.config.maxTokens
		) {
			return true;
		}
		return false;
	}

	async compact(
		threadId: ThreadId,
		items: readonly ItemSnapshot[],
		knownTurnIds: readonly TurnId[],
	): Promise<RuntimeCompactionResult> {
		const keepTurns = this.config.keepRecentTurns ?? 2;
		if (knownTurnIds.length <= keepTurns) {
			return {
				compacted: false,
				turnsCompacted: 0,
				itemsCompacted: 0,
				remainingItems: items,
			};
		}

		// Partition turns: older turns to compact, recent turns to preserve
		const splitIndex = knownTurnIds.length - keepTurns;
		const turnsToCompact = new Set(knownTurnIds.slice(0, splitIndex));
		const lastCompactedTurnId = knownTurnIds[splitIndex - 1]!;

		const itemsToCompact: ItemSnapshot[] = [];
		const preservedItems: ItemSnapshot[] = [];

		for (const item of items) {
			if (turnsToCompact.has(item.turnId as TurnId)) {
				itemsToCompact.push(item);
			} else {
				preservedItems.push(item);
			}
		}

		if (itemsToCompact.length === 0) {
			return {
				compacted: false,
				turnsCompacted: 0,
				itemsCompacted: 0,
				remainingItems: items,
			};
		}

		const summarizer = this.config.summarizer ?? defaultSummarizer;
		const summaryText = await summarizer(itemsToCompact);

		const now = Date.now();
		const summaryItem: ItemSnapshot = {
			itemId: asItemId(`comp_${now}_${Math.random().toString(36).slice(2, 6)}`),
			threadId,
			turnId: lastCompactedTurnId,
			type: "notice",
			content: {
				isCompactedSummary: true,
				turnsCount: turnsToCompact.size,
				itemsCount: itemsToCompact.length,
				summary: summaryText,
			},
			createdAt: now,
			completedAt: now,
		};

		return {
			compacted: true,
			turnsCompacted: turnsToCompact.size,
			itemsCompacted: itemsToCompact.length,
			summaryText,
			summaryItem,
			remainingItems: [summaryItem, ...preservedItems],
		};
	}

	createJournalFact(
		threadId: ThreadId,
		result: RuntimeCompactionResult,
		lastCompactedTurnId?: TurnId,
	): CompactionJournalFact | undefined {
		if (!result.compacted || !result.summaryText) {
			return undefined;
		}

		return {
			kind: "thread_compacted",
			threadId,
			compactedUpToTurnId: lastCompactedTurnId ?? asTurnId("turn_compacted"),
			turnsCompacted: result.turnsCompacted,
			itemsCompacted: result.itemsCompacted,
			summaryText: result.summaryText,
			timestamp: Date.now(),
		};
	}
}

async function defaultSummarizer(items: readonly ItemSnapshot[]): Promise<string> {
	const summaryLines: string[] = [`Compacted ${items.length} historical conversation items:`];

	for (const item of items) {
		const text = typeof item.content === "string" ? item.content : JSON.stringify(item.content);
		const snippet = text.length > 80 ? `${text.slice(0, 80)}...` : text;
		summaryLines.push(`- [${item.type}] ${snippet}`);
	}

	return summaryLines.join("\n");
}
