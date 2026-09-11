import type { ClientMessageV2, ServerMessageV2 } from "@earendil-works/pi-protocol";

export type MessageHandler = (message: ClientMessageV2) => void | Promise<void>;
export type CloseHandler = () => void;
export type ErrorHandler = (error: Error) => void;

export interface ProtocolTransport {
	readonly id: string;
	readonly isClosed: boolean;
	send(message: ServerMessageV2): Promise<boolean>;
	onMessage(handler: MessageHandler): void;
	onClose(handler: CloseHandler): void;
	onError(handler: ErrorHandler): void;
	close(): Promise<void>;
}

export interface BoundedQueueOptions {
	readonly maxQueueSize?: number;
	readonly maxBufferBytes?: number;
	readonly onSlowClient?: "drop_live" | "disconnect";
}
