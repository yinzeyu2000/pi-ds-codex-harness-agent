import { asItemId, asThreadId, asTurnId, type ItemSnapshot } from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import { CompactionEngine } from "../../src/runtime/compaction/compactor.ts";

describe("M8 Context Compaction Engine", () => {
	it("correctly triggers shouldCompact based on turn, item, and token thresholds", () => {
		const compactor = new CompactionEngine({
			maxTurns: 5,
			maxItems: 10,
			maxTokens: 1000,
			keepRecentTurns: 2,
		});

		expect(compactor.shouldCompact(3, 4, 200)).toBe(false);
		expect(compactor.shouldCompact(5, 4, 200)).toBe(true);
		expect(compactor.shouldCompact(2, 10, 200)).toBe(true);
		expect(compactor.shouldCompact(2, 4, 1050)).toBe(true);
	});

	it("compacts older conversation turns while preserving recent turns untouched", async () => {
		const compactor = new CompactionEngine({
			maxTurns: 3,
			keepRecentTurns: 1, // keep only the last turn untouched
		});

		const threadId = asThreadId("th_compact_1");
		const turn1 = asTurnId("turn_1");
		const turn2 = asTurnId("turn_2");
		const turn3 = asTurnId("turn_3");

		const items: ItemSnapshot[] = [
			{
				itemId: asItemId("item_1"),
				threadId,
				turnId: turn1,
				type: "user_message",
				content: "What is 2 + 2?",
				createdAt: 1000,
			},
			{
				itemId: asItemId("item_2"),
				threadId,
				turnId: turn1,
				type: "assistant_message",
				content: "2 + 2 = 4",
				createdAt: 1050,
			},
			{
				itemId: asItemId("item_3"),
				threadId,
				turnId: turn2,
				type: "user_message",
				content: "Multiply that by 10",
				createdAt: 2000,
			},
			{
				itemId: asItemId("item_4"),
				threadId,
				turnId: turn2,
				type: "assistant_message",
				content: "4 * 10 = 40",
				createdAt: 2050,
			},
			{
				itemId: asItemId("item_5"),
				threadId,
				turnId: turn3,
				type: "user_message",
				content: "Now add 5",
				createdAt: 3000,
			},
		];

		const knownTurns = [turn1, turn2, turn3];

		const result = await compactor.compact(threadId, items, knownTurns);

		expect(result.compacted).toBe(true);
		expect(result.turnsCompacted).toBe(2);
		expect(result.itemsCompacted).toBe(4);
		expect(result.summaryItem).toBeDefined();
		expect(result.summaryItem?.type).toBe("notice");

		// Remaining items should be: summaryItem + turn3 items (item_5)
		expect(result.remainingItems.length).toBe(2);
		expect(result.remainingItems[0]?.itemId).toBe(result.summaryItem?.itemId);
		expect(result.remainingItems[1]?.itemId).toBe(asItemId("item_5"));
	});

	it("creates a canonical journal fact for durable replay persistence", async () => {
		const compactor = new CompactionEngine({ keepRecentTurns: 1 });
		const threadId = asThreadId("th_journal_compact");
		const turn1 = asTurnId("turn_1");
		const turn2 = asTurnId("turn_2");

		const items: ItemSnapshot[] = [
			{
				itemId: asItemId("item_1"),
				threadId,
				turnId: turn1,
				type: "user_message",
				content: "Historical prompt",
				createdAt: 1000,
			},
			{
				itemId: asItemId("item_2"),
				threadId,
				turnId: turn2,
				type: "user_message",
				content: "Active prompt",
				createdAt: 2000,
			},
		];

		const result = await compactor.compact(threadId, items, [turn1, turn2]);
		expect(result.compacted).toBe(true);

		const fact = compactor.createJournalFact(threadId, result, turn1);
		expect(fact).toBeDefined();
		expect(fact?.kind).toBe("thread_compacted");
		expect(fact?.threadId).toBe(threadId);
		expect(fact?.compactedUpToTurnId).toBe(turn1);
		expect(fact?.turnsCompacted).toBe(1);
		expect(fact?.itemsCompacted).toBe(1);
	});
});
