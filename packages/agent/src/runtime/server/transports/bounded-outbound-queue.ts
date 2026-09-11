import type { ServerMessageV2 } from "@earendil-works/pi-protocol";
import type { BoundedQueueOptions } from "./types.ts";

export class BoundedOutboundQueue {
	private readonly maxQueueSize: number;
	private readonly maxBufferBytes: number;
	private readonly onSlowClient: "drop_live" | "disconnect";
	private readonly sender: (message: ServerMessageV2) => Promise<boolean>;
	private readonly onDisconnect: (reason: string) => void;

	private readonly queue: ServerMessageV2[] = [];
	private bufferedBytes = 0;
	private sending = false;
	private closed = false;
	private liveGapOccurred = false;
	private droppedLiveEventsCount = 0;
	private lastDroppedThreadId?: string;

	constructor(
		sender: (message: ServerMessageV2) => Promise<boolean>,
		onDisconnect: (reason: string) => void,
		options: BoundedQueueOptions = {},
	) {
		this.sender = sender;
		this.onDisconnect = onDisconnect;
		this.maxQueueSize = options.maxQueueSize ?? 500;
		this.maxBufferBytes = options.maxBufferBytes ?? 512 * 1024;
		this.onSlowClient = options.onSlowClient ?? "drop_live";
	}

	get pendingCount(): number {
		return this.queue.length;
	}

	get bufferedByteCount(): number {
		return this.bufferedBytes;
	}

	get droppedCount(): number {
		return this.droppedLiveEventsCount;
	}

	enqueue(message: ServerMessageV2): boolean {
		if (this.closed) return false;

		const serializedLen = JSON.stringify(message).length;

		// Check if queue has exceeded capacity
		const isFull = this.queue.length >= this.maxQueueSize || this.bufferedBytes + serializedLen > this.maxBufferBytes;

		if (isFull) {
			if (this.onSlowClient === "drop_live" && message.type === "live") {
				this.liveGapOccurred = true;
				this.droppedLiveEventsCount++;
				this.lastDroppedThreadId = message.event.threadId;
				return false;
			}

			if (this.onSlowClient === "disconnect" || isFull) {
				this.closed = true;
				this.onDisconnect(`Outbound queue overflow: size=${this.queue.length}, bytes=${this.bufferedBytes}`);
				return false;
			}
		}

		this.queue.push(message);
		this.bufferedBytes += serializedLen;
		void this.drain();
		return true;
	}

	private async drain(): Promise<void> {
		if (this.sending || this.closed) return;
		this.sending = true;

		try {
			while (this.queue.length > 0 && !this.closed) {
				const next = this.queue[0];
				const serializedLen = JSON.stringify(next).length;

				const ok = await this.sender(next);
				if (!ok) {
					this.closed = true;
					this.onDisconnect("Failed to send message over transport");
					break;
				}

				this.queue.shift();
				this.bufferedBytes = Math.max(0, this.bufferedBytes - serializedLen);

				// If we previously dropped live events and buffer cleared, notify client of live_gap
				if (this.liveGapOccurred && this.queue.length === 0) {
					this.liveGapOccurred = false;
					const threadId =
						this.lastDroppedThreadId ??
						(next.type === "live"
							? next.event.threadId
							: next.type === "event"
								? next.event.threadId
								: undefined);
					this.lastDroppedThreadId = undefined;
					if (threadId) {
						const gapEnvelope: ServerMessageV2 = {
							type: "live",
							event: {
								threadId,
								type: "live_gap",
								cursorSeq: 0,
								payload: {
									reason: "slow_client_dropped_live_events",
									droppedCount: this.droppedLiveEventsCount,
								},
								timestamp: Date.now(),
							},
						};
						await this.sender(gapEnvelope);
					}
				}
			}
		} finally {
			this.sending = false;
			if (this.queue.length > 0 && !this.closed) {
				void this.drain();
			}
		}
	}

	close(): void {
		this.closed = true;
		this.queue.length = 0;
		this.bufferedBytes = 0;
		this.lastDroppedThreadId = undefined;
	}
}
