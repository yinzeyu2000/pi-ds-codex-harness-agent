import net from "node:net";
import type { ClientMessageV2, ServerMessageV2 } from "@earendil-works/pi-protocol";
import { BoundedOutboundQueue } from "./bounded-outbound-queue.ts";
import type { BoundedQueueOptions, CloseHandler, ErrorHandler, MessageHandler, ProtocolTransport } from "./types.ts";

export class IpcTransport implements ProtocolTransport {
	readonly id: string;
	private readonly socket: net.Socket;
	private readonly outboundQueue: BoundedOutboundQueue;

	private _isClosed = false;
	private messageHandler?: MessageHandler;
	private closeHandler?: CloseHandler;
	private errorHandler?: ErrorHandler;
	private lineBuffer = "";

	constructor(socket: net.Socket, options: BoundedQueueOptions & { id?: string } = {}) {
		this.id = options.id ?? `ipc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		this.socket = socket;

		this.outboundQueue = new BoundedOutboundQueue(
			async (msg) => this.writeDirect(msg),
			(reason) => {
				this.handleError(new Error(reason));
				void this.close();
			},
			options,
		);

		this.setupSocket();
	}

	get isClosed(): boolean {
		return this._isClosed;
	}

	private setupSocket(): void {
		this.socket.setEncoding("utf8");

		this.socket.on("data", (chunk: string) => {
			this.handleData(chunk);
		});

		this.socket.on("end", () => {
			void this.close();
		});

		this.socket.on("close", () => {
			void this.close();
		});

		this.socket.on("error", (err: Error) => {
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
					this.handleError(new Error(`Failed to parse incoming IPC JSON line: ${String(err)}`));
				}
			}

			newlineIndex = this.lineBuffer.indexOf("\n");
		}
	}

	private writeDirect(message: ServerMessageV2): Promise<boolean> {
		if (this._isClosed || this.socket.destroyed || !this.socket.writable) return Promise.resolve(false);

		return new Promise<boolean>((resolve) => {
			const line = `${JSON.stringify(message)}\n`;
			const canContinue = this.socket.write(line, "utf8", (err) => {
				if (err) {
					this.handleError(err);
					resolve(false);
				} else {
					resolve(true);
				}
			});

			if (!canContinue) {
				this.socket.once("drain", () => {});
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
			if (!this.socket.destroyed) {
				await new Promise<void>((resolve) => {
					this.socket.end(() => {
						this.socket.destroy();
						resolve();
					});
				});
			}
		} catch {
			this.socket.destroy();
		}

		if (this.closeHandler) {
			try {
				this.closeHandler();
			} catch {
				// Suppress handler errors
			}
		}
	}
}

export function createIpcServer(
	pipeOrPath: string,
	onTransport: (transport: IpcTransport) => void,
	options: BoundedQueueOptions = {},
): net.Server {
	const server = net.createServer((socket) => {
		const transport = new IpcTransport(socket, options);
		onTransport(transport);
	});

	server.listen(pipeOrPath);
	return server;
}

export function connectIpcClient(pipeOrPath: string, options: BoundedQueueOptions = {}): Promise<IpcTransport> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(pipeOrPath);
		socket.once("connect", () => {
			const transport = new IpcTransport(socket, options);
			resolve(transport);
		});
		socket.once("error", reject);
	});
}
