import {
	asClientRequestId,
	asControllerEpoch,
	type ClientCapabilities,
	type ClientInfo,
	type ClientMessageV2,
	type ControllerLease,
	type LiveEventEnvelope,
	PROTOCOL_V2_VERSION,
	type ProtocolV2RequestEnvelope,
	type ProtocolV2ResponseEnvelope,
	type ServerCapabilities,
	type ServerHelloV2,
	type ServerMessageV2,
	type ThreadWatchResult,
	type TurnStartResult,
	type WireEventEnvelope,
} from "@earendil-works/pi-protocol";
import type { ProtocolTransport } from "../server/transports/types.ts";

export interface DiagnosticClientOptions {
	readonly clientInfo?: Partial<ClientInfo>;
	readonly capabilities?: Partial<ClientCapabilities>;
	readonly timeoutMs?: number;
}

export class DiagnosticClient {
	readonly transport: ProtocolTransport;
	readonly options: DiagnosticClientOptions;

	connectionId?: string;
	serverCapabilities?: ServerCapabilities;
	private readonly pendingRequests = new Map<
		string,
		{
			resolve: (res: ProtocolV2ResponseEnvelope) => void;
			reject: (err: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();

	private readonly wireEventListeners = new Set<(evt: WireEventEnvelope) => void>();
	private readonly liveEventListeners = new Set<(evt: LiveEventEnvelope) => void>();
	private readonly threadEpochs = new Map<string, number>();
	private isConnected = false;
	private isClosed = false;
	private pendingHandshake?: {
		resolve: (val: ServerHelloV2) => void;
		reject: (err: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	};

	constructor(transport: ProtocolTransport, options: DiagnosticClientOptions = {}) {
		this.transport = transport;
		this.options = options;
		this.setupTransport();
	}

	private setupTransport(): void {
		this.transport.onMessage((msg) => {
			this.handleMessage(msg as unknown as ServerMessageV2);
		});

		this.transport.onClose(() => {
			this.handleClose();
		});

		this.transport.onError((err) => {
			this.handleClose(err);
		});
	}

	private handleMessage(message: ServerMessageV2): void {
		if (message.type === "hello") {
			if (this.pendingHandshake) {
				clearTimeout(this.pendingHandshake.timer);
				const { resolve } = this.pendingHandshake;
				this.pendingHandshake = undefined;
				this.connectionId = message.connectionId;
				this.serverCapabilities = message.serverCapabilities;
				this.isConnected = true;

				void this.transport.send({
					type: "initialized",
				} as unknown as ServerMessageV2);

				resolve(message);
			}
			return;
		}

		if (message.type === "hello_error") {
			if (this.pendingHandshake) {
				clearTimeout(this.pendingHandshake.timer);
				const { reject } = this.pendingHandshake;
				this.pendingHandshake = undefined;
				reject(new Error(`Handshake failed: ${message.code} - ${message.message}`));
			}
			return;
		}

		if (message.type === "response") {
			const pending = this.pendingRequests.get(message.id);
			if (pending) {
				clearTimeout(pending.timer);
				this.pendingRequests.delete(message.id);
				pending.resolve(message);
			}
			return;
		}

		if (message.type === "event") {
			for (const listener of this.wireEventListeners) {
				try {
					listener(message.event);
				} catch {
					// Suppress listener error
				}
			}
			return;
		}

		if (message.type === "live") {
			for (const listener of this.liveEventListeners) {
				try {
					listener(message.event);
				} catch {
					// Suppress listener error
				}
			}
			return;
		}
	}

	private handleClose(error?: Error): void {
		if (this.isClosed) return;
		this.isClosed = true;

		const rejectionError = error ?? new Error("DiagnosticClient transport closed");
		if (this.pendingHandshake) {
			clearTimeout(this.pendingHandshake.timer);
			this.pendingHandshake.reject(rejectionError);
			this.pendingHandshake = undefined;
		}
		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timer);
			pending.reject(rejectionError);
		}
		this.pendingRequests.clear();
	}

	async handshake(): Promise<ServerHelloV2> {
		if (this.isConnected) {
			throw new Error("Handshake already completed");
		}
		if (this.isClosed) {
			throw new Error("DiagnosticClient is closed");
		}

		return new Promise<ServerHelloV2>((resolve, reject) => {
			const timeoutMs = this.options.timeoutMs ?? 5000;
			const timer = setTimeout(() => {
				if (this.pendingHandshake) {
					this.pendingHandshake = undefined;
					reject(new Error("Handshake timed out"));
				}
			}, timeoutMs);

			this.pendingHandshake = { resolve, reject, timer };

			// Send hello
			const hello: ClientMessageV2 = {
				type: "hello",
				version: PROTOCOL_V2_VERSION,
				clientInfo: {
					name: this.options.clientInfo?.name ?? "diagnostic-client",
					version: this.options.clientInfo?.version ?? "1.0.0",
					uiType: this.options.clientInfo?.uiType ?? "headless",
				},
				capabilities: {
					streamingDeltas: true,
					approvalPrompts: true,
					controllerLease: true,
					binaryFrames: false,
					processInteractivePty: false,
					...this.options.capabilities,
				},
			};

			void this.transport.send(hello as unknown as ServerMessageV2);
		});
	}

	async sendRequest(request: ProtocolV2RequestEnvelope["request"]): Promise<ProtocolV2ResponseEnvelope> {
		if (this.isClosed) {
			throw new Error("Client is closed");
		}

		const reqId = `diag_req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const envelope: ProtocolV2RequestEnvelope = {
			type: "request",
			id: reqId,
			request,
		};

		return new Promise<ProtocolV2ResponseEnvelope>((resolve, reject) => {
			const timeoutMs = this.options.timeoutMs ?? 10000;
			const timer = setTimeout(() => {
				this.pendingRequests.delete(reqId);
				reject(new Error(`Request ${reqId} timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			this.pendingRequests.set(reqId, { resolve, reject, timer });
			void this.transport.send(envelope as unknown as ServerMessageV2);
		});
	}

	async acquireController(threadId: string, controllerId?: string, ttlMs = 60000): Promise<ControllerLease> {
		const useControllerId = controllerId ?? this.connectionId ?? "diag_ctrl";
		const response = await this.sendRequest({
			command: "controller/acquire",
			threadId,
			controllerId: useControllerId,
			ttlMs,
		});

		if (!response.ok) {
			throw new Error(`controller/acquire failed: ${response.error.code} - ${response.error.message}`);
		}

		if (response.result.command === "controller/acquire") {
			const lease: ControllerLease = {
				threadId: response.result.lease.threadId,
				controllerId: response.result.lease.controllerId,
				epoch: asControllerEpoch(response.result.lease.epoch),
				acquiredAt: response.result.lease.acquiredAt,
				expiresAt: response.result.lease.expiresAt,
			};
			this.threadEpochs.set(threadId, response.result.lease.epoch);
			return lease;
		}

		throw new Error("Unexpected response for controller/acquire");
	}

	async releaseController(threadId: string, controllerId?: string, epoch?: number): Promise<boolean> {
		const useControllerId = controllerId ?? this.connectionId ?? "diag_ctrl";
		const useEpoch = epoch ?? this.threadEpochs.get(threadId) ?? 1;
		const response = await this.sendRequest({
			command: "controller/release",
			threadId,
			controllerId: useControllerId,
			epoch: asControllerEpoch(useEpoch),
		});

		if (!response.ok) {
			return false;
		}
		this.threadEpochs.delete(threadId);
		return true;
	}

	async watchThread(threadId: string, afterSeq?: number): Promise<ThreadWatchResult> {
		const response = await this.sendRequest({
			command: "thread/watch",
			threadId,
			afterSeq,
		});

		if (!response.ok) {
			throw new Error(`thread/watch failed: ${response.error.code} - ${response.error.message}`);
		}

		if (response.result.command === "thread/watch") {
			return response.result as unknown as ThreadWatchResult;
		}

		throw new Error("Unexpected response for thread/watch");
	}

	async startTurn(
		threadId: string,
		input: unknown,
		clientRequestId?: string,
		epoch?: number,
	): Promise<TurnStartResult> {
		const useEpoch = epoch ?? this.threadEpochs.get(threadId) ?? 1;
		const useReqId = clientRequestId ?? `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

		const response = await this.sendRequest({
			command: "turn/start",
			threadId,
			input,
			clientRequestId: asClientRequestId(useReqId),
			controllerEpoch: asControllerEpoch(useEpoch),
		});

		if (!response.ok) {
			throw new Error(`turn/start failed: ${response.error.code} - ${response.error.message}`);
		}

		if (response.result.command === "turn/start") {
			return response.result as unknown as TurnStartResult;
		}

		throw new Error("Unexpected response for turn/start");
	}

	async steerTurn(
		threadId: string,
		turnId: string,
		input: unknown,
		clientRequestId?: string,
		epoch?: number,
	): Promise<void> {
		const useEpoch = epoch ?? this.threadEpochs.get(threadId) ?? 1;
		const useReqId = clientRequestId ?? `req_steer_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

		const response = await this.sendRequest({
			command: "turn/steer",
			threadId,
			turnId,
			input,
			clientRequestId: asClientRequestId(useReqId),
			controllerEpoch: asControllerEpoch(useEpoch),
		});

		if (!response.ok) {
			throw new Error(`turn/steer failed: ${response.error.code} - ${response.error.message}`);
		}
	}

	async interruptTurn(threadId: string, turnId: string, clientRequestId?: string, epoch?: number): Promise<void> {
		const useEpoch = epoch ?? this.threadEpochs.get(threadId) ?? 1;
		const useReqId = clientRequestId ?? `req_intr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

		const response = await this.sendRequest({
			command: "turn/interrupt",
			threadId,
			turnId,
			clientRequestId: asClientRequestId(useReqId),
			controllerEpoch: asControllerEpoch(useEpoch),
		});

		if (!response.ok) {
			throw new Error(`turn/interrupt failed: ${response.error.code} - ${response.error.message}`);
		}
	}

	async respondApproval(
		threadId: string,
		turnId: string,
		requestId: string,
		decision: "approved" | "rejected",
		clientRequestId?: string,
		epoch?: number,
	): Promise<void> {
		const useEpoch = epoch ?? this.threadEpochs.get(threadId) ?? 1;
		const useReqId = clientRequestId ?? `req_appr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

		const response = await this.sendRequest({
			command: "approval/respond",
			threadId,
			turnId,
			requestId,
			decision,
			clientRequestId: asClientRequestId(useReqId),
			controllerEpoch: asControllerEpoch(useEpoch),
		});

		if (!response.ok) {
			throw new Error(`approval/respond failed: ${response.error.code} - ${response.error.message}`);
		}
	}

	onWireEvent(listener: (evt: WireEventEnvelope) => void): { dispose: () => void } {
		this.wireEventListeners.add(listener);
		return { dispose: () => this.wireEventListeners.delete(listener) };
	}

	onLiveEvent(listener: (evt: LiveEventEnvelope) => void): { dispose: () => void } {
		this.liveEventListeners.add(listener);
		return { dispose: () => this.liveEventListeners.delete(listener) };
	}

	onApprovalRequested(listener: (evt: WireEventEnvelope) => void): { dispose: () => void } {
		const handler = (evt: WireEventEnvelope) => {
			if (evt.type === "approval.requested") {
				listener(evt);
			}
		};
		this.wireEventListeners.add(handler);
		return { dispose: () => this.wireEventListeners.delete(handler) };
	}

	onApprovalResolved(listener: (evt: WireEventEnvelope) => void): { dispose: () => void } {
		const handler = (evt: WireEventEnvelope) => {
			if (evt.type === "approval.resolved") {
				listener(evt);
			}
		};
		this.wireEventListeners.add(handler);
		return { dispose: () => this.wireEventListeners.delete(handler) };
	}

	async close(): Promise<void> {
		if (this.isClosed) return;
		await this.transport.close();
		this.handleClose();
	}
}
