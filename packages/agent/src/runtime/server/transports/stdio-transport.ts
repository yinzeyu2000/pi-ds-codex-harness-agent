import type { Readable, Writable } from "node:stream";
import type { ClientMessageV2, ServerMessageV2 } from "@earendil-works/pi-protocol";
import { BoundedOutboundQueue } from "./bounded-outbound-queue.ts";
import type { BoundedQueueOptions, CloseHandler, ErrorHandler, MessageHandler, ProtocolTransport } from "./types.ts";

export class StdioTransport implements ProtocolTransport {
	readonly id: string;
	private readonly input: Readable;
	private readonly output: Writable;
	private readonly outboundQueue: BoundedOutboundQueue;

	private _isClosed = false;
	private messageHandler?: MessageHandler;
	private closeHandler?: CloseHandler;
	private errorHandler?: ErrorHandler;
	private lineBuffer = "";

	constructor(input: Readable, output: Writable, options: BoundedQueueOptions & { id?: string } = {}) {
		this.id = options.id ?? `stdio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		this.input = input;
		this.output = output;

		this.outboundQueue = new BoundedOutboundQueue(
			async (msg) => this.writeDirect(msg),
			(reason) => {
				this.handleError(new Error(reason));
				void this.close();
			},
			options,
		);

		this.setupStreams();
	}

	get isClosed(): boolean {
		return this._isClosed;
	}

	private setupStreams(): void {
		this.input.setEncoding("utf8");

		this.input.on("data", (chunk: string) => {
			this.handleData(chunk);
		});

		this.input.on("end", () => {
			void this.close();
		});

		this.input.on("error", (err: Error) => {
			this.handleError(err);
			void this.close();
		});

		this.output.on("error", (err: Error) => {
			this.handleError(err);
			void this.close();
		});
	}

	private handleData(chunk: string): void {
		if (this._isClosed) return;

		this.lineBuffer += chunk;
		let newlineIndex = this.lineBuffer.indexOf("\n");

		while (newlineIndex !== -1) {
			const line = this.lineBuffer.slice(0, newlineIndex).trim();
			this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);

			if (line.length > 0) {
				try {
					const parsed = JSON.parse(line) as ClientMessageV2;
					if (this.messageHandler) {
						void this.messageHandler(parsed);
					}
				} catch (err) {
					this.handleError(new Error(`Failed to parse incoming JSON line: ${String(err)}`));
				}
			}

			newlineIndex = this.lineBuffer.indexOf("\n");
		}
	}

	private writeDirect(message: ServerMessageV2): Promise<boolean> {
		if (this._isClosed || !this.output.writable) return Promise.resolve(false);

		return new Promise<boolean>((resolve) => {
			const line = `${JSON.stringify(message)}\n`;
			const canContinue = this.output.write(line, "utf8", (err) => {
				if (err) {
					this.handleError(err);
					resolve(false);
				} else {
					resolve(true);
				}
			});

			if (!canContinue && this.output.once) {
				this.output.once("drain", () => {});
			}
		});
	}

	send(message: ServerMessageV2): Promise<boolean> {
		if (this._isClosed) return Promise.resolve(false);
		const enqueued = this.outboundQueue.enqueue(message);
		return Promise.resolve(enqueued);
	}

	onMessage(handler: MessageHandler): void {
		this.messageHandler = handler;
	}

	onClose(handler: CloseHandler): void {
		this.closeHandler = handler;
	}

	onError(handler: ErrorHandler): void {
		this.errorHandler = handler;
	}

	private handleError(error: Error): void {
		if (this.errorHandler) {
			try {
				this.errorHandler(error);
			} catch {
				// Prevent error handler from breaking transport loop
			}
		}
	}

	async close(): Promise<void> {
		if (this._isClosed) return;
		this._isClosed = true;

		this.outboundQueue.close();

		try {
			if (typeof this.input.destroy === "function") {
				this.input.destroy();
			}
			if (typeof this.output.end === "function" && this.output.writable) {
				await new Promise<void>((resolve) => {
					this.output.end(() => resolve());
				});
			}
		} catch {
			// Best effort close
		}

		if (this.closeHandler) {
			try {
				this.closeHandler();
			} catch {
				// Suppress handler errors on close
			}
		}
	}
}
