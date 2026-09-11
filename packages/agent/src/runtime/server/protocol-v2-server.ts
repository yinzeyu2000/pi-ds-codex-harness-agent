import {
	asClientRequestId,
	asControllerEpoch,
	asEventId,
	asThreadId,
	asTurnId,
	type ClientCapabilities,
	type ClientInfo,
	type ClientMessageV2,
	type ControllerEpoch,
	type ControllerLease,
	type DeduplicationKey,
	PROTOCOL_V2_VERSION,
	type ProtocolV2Error,
	type ProtocolV2RequestEnvelope,
	type ProtocolV2ResponseEnvelope,
	type ServerCapabilities,
	type ServerHelloV2,
	type ServerMessageV2,
	type ThreadId,
	type WireEventEnvelope,
} from "@earendil-works/pi-protocol";

function generateConnectionId(): string {
	if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function") {
		return `conn_${globalThis.crypto.randomUUID().slice(0, 8)}`;
	}
	return `conn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

import { MemoryJournalStore } from "../journal/memory-journal.ts";
import { ApprovalManagerImpl } from "../security/approval.ts";
import { ThreadRuntimeImpl } from "../thread/thread-runtime-impl.ts";
import { type AgentDriver, FakeDriver } from "../types/agent-driver.ts";
import { ActiveTurnConflictError, CommandDeduplicationConflictError, ControllerFencingError } from "../types/errors.ts";
import type { JournalWriter, ThreadJournalStore } from "../types/journal.ts";
import type { ApprovalManager } from "../types/providers.ts";
import type { RuntimeHost } from "../types/runtime-host.ts";
import type { ThreadRuntime } from "../types/thread-runtime.ts";
import { ControllerLeaseManager } from "./controller-lease-manager.ts";
import { CommandDeduplicator } from "./deduplicator.ts";
import { DurableWatchManager } from "./durable-watch-manager.ts";
import type { ProtocolTransport } from "./transports/types.ts";

export interface ProtocolV2ServerOptions {
	readonly runtimeHost: RuntimeHost;
	readonly journalStore?: ThreadJournalStore;
	readonly driverFactory?: (threadId: ThreadId) => AgentDriver;
	readonly deduplicator?: CommandDeduplicator;
	readonly leaseManager?: ControllerLeaseManager;
	readonly approvalManager?: ApprovalManager;
	readonly serverCapabilities?: Partial<ServerCapabilities>;
	readonly handshakeTimeoutMs?: number;
}

interface ServerConnectionState {
	readonly id: string;
	readonly transport: ProtocolTransport;
	stage: "awaiting_hello" | "handshaking" | "ready" | "closed";
	clientInfo?: ClientInfo;
	clientCapabilities?: ClientCapabilities;
	handshakeTimer?: ReturnType<typeof setTimeout>;
	readonly leasedThreads: Set<ThreadId>;
}

export class ProtocolV2Server {
	readonly runtimeHost: RuntimeHost;
	readonly journalStore?: ThreadJournalStore;
	readonly driverFactory?: (threadId: ThreadId) => AgentDriver;
	readonly deduplicator: CommandDeduplicator;
	readonly leaseManager: ControllerLeaseManager;
	readonly watchManager: DurableWatchManager;
	readonly approvalManager: ApprovalManager;
	readonly serverCapabilities: ServerCapabilities;
	private readonly handshakeTimeoutMs: number;

	private readonly connections = new Map<string, ServerConnectionState>();
	private readonly loadingRuntimes = new Map<string, Promise<ThreadRuntime>>();
	private isClosing = false;

	constructor(options: ProtocolV2ServerOptions) {
		this.runtimeHost = options.runtimeHost;
		this.journalStore = options.journalStore;
		this.driverFactory = options.driverFactory;
		this.deduplicator = options.deduplicator ?? new CommandDeduplicator();
		this.leaseManager = options.leaseManager ?? new ControllerLeaseManager();
		this.approvalManager = options.approvalManager ?? new ApprovalManagerImpl();
		this.watchManager = new DurableWatchManager(options.journalStore);
		this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5000;

		// Cancel approvals for thread on controller lease revocation (fail-closed)
		this.leaseManager.onAnyLeaseRevoked((threadId, _lease, reason) => {
			for (const conn of this.connections.values()) {
				conn.leasedThreads.delete(threadId);
			}
			if (this.approvalManager instanceof ApprovalManagerImpl) {
				this.approvalManager.cancelAllForThread(threadId, reason);
			}
		});

		this.setupApprovalBroadcaster();

		this.serverCapabilities = {
			protocolVersion: PROTOCOL_V2_VERSION,
			fencedControllers: true,
			commandDeduplication: true,
			durableReplay: true,
			liveGapsNotice: true,
			sandboxing: true,
			maxPayloadBytes: 4 * 1024 * 1024,
			...options.serverCapabilities,
		};
	}

	get activeConnectionCount(): number {
		return this.connections.size;
	}

	accept(transport: ProtocolTransport): string {
		if (this.isClosing) {
			void transport.close();
			return "";
		}

		const connectionId = transport.id || generateConnectionId();
		const state: ServerConnectionState = {
			id: connectionId,
			transport,
			stage: "awaiting_hello",
			leasedThreads: new Set(),
		};

		const timer = setTimeout(() => {
			if (state.stage !== "ready" && state.stage !== "closed") {
				void this.failHandshake(state, "handshake_timeout", "Handshake timed out");
			}
		}, this.handshakeTimeoutMs);

		if (typeof timer.unref === "function") {
			timer.unref();
		}
		state.handshakeTimer = timer;

		this.connections.set(connectionId, state);

		transport.onMessage((msg) => this.handleClientMessage(state, msg));
		transport.onClose(() => this.handleConnectionClose(state));
		transport.onError((_err) => {
			this.handleConnectionClose(state);
		});

		return connectionId;
	}

	private async handleClientMessage(state: ServerConnectionState, message: ClientMessageV2): Promise<void> {
		if (state.stage === "closed" || this.isClosing) return;

		// 1. Handshake Phase
		if (state.stage === "awaiting_hello") {
			if (message.type !== "hello") {
				await this.failHandshake(state, "protocol_violation", "First message must be hello");
				return;
			}

			if (message.version !== PROTOCOL_V2_VERSION) {
				await this.failHandshake(
					state,
					"unsupported_version",
					`Expected protocol version ${PROTOCOL_V2_VERSION}, got ${message.version}`,
				);
				return;
			}

			state.clientInfo = message.clientInfo;
			state.clientCapabilities = message.capabilities;
			state.stage = "handshaking";

			const serverHello: ServerHelloV2 = {
				type: "hello",
				version: PROTOCOL_V2_VERSION,
				connectionId: state.id,
				serverCapabilities: this.serverCapabilities,
			};

			await state.transport.send(serverHello);
			return;
		}

		if (state.stage === "handshaking") {
			if (message.type !== "initialized") {
				await this.failHandshake(state, "protocol_violation", "Expected initialized notification after hello");
				return;
			}

			if (state.handshakeTimer) {
				clearTimeout(state.handshakeTimer);
				state.handshakeTimer = undefined;
			}

			state.stage = "ready";
			return;
		}

		// 2. Ready Phase - Dispatch Request
		if (message.type === "request") {
			await this.handleRequest(state, message);
			return;
		}

		// Reject unexpected hello or initialized once ready
		if (message.type === "hello" || message.type === "initialized") {
			// Ignore redundant handshake messages
			return;
		}
	}

	private async handleRequest(state: ServerConnectionState, envelope: ProtocolV2RequestEnvelope): Promise<void> {
		const req = envelope.request;

		try {
			switch (req.command) {
				case "controller/acquire": {
					const threadId = asThreadId(req.threadId);
					const lease = this.leaseManager.acquire(threadId, req.controllerId, req.ttlMs);
					state.leasedThreads.add(threadId);
					await this.sendSuccess(state, envelope.id, {
						command: "controller/acquire",
						lease,
					});
					break;
				}

				case "controller/release": {
					const threadId = asThreadId(req.threadId);
					const epoch = asControllerEpoch(req.epoch);
					const released = this.leaseManager.release(threadId, req.controllerId, epoch);
					state.leasedThreads.delete(threadId);
					await this.sendSuccess(state, envelope.id, {
						command: "controller/release",
						released,
						epoch: req.epoch,
					});
					break;
				}

				case "turn/start": {
					const threadId = asThreadId(req.threadId);
					const clientRequestId = asClientRequestId(req.clientRequestId);
					const epoch = asControllerEpoch(req.controllerEpoch);

					const dedupeKey: DeduplicationKey = {
						principalId: state.id,
						threadId,
						method: "turn/start",
						clientRequestId,
					};

					const dedupeStatus = this.deduplicator.checkOrAdmit(dedupeKey, req.input);

					if (dedupeStatus.type === "settled") {
						if (dedupeStatus.receipt.ok) {
							await this.sendSuccess(state, envelope.id, dedupeStatus.receipt.result as any);
						} else {
							await this.sendError(state, envelope.id, {
								code: dedupeStatus.receipt.error?.code ?? "turn_failed",
								message: dedupeStatus.receipt.error?.message ?? "Turn execution failed",
							});
						}
						return;
					}

					if (dedupeStatus.type === "in_flight") {
						const result = await dedupeStatus.promise;
						if (result.ok) {
							await this.sendSuccess(state, envelope.id, result.result as any);
						} else {
							await this.sendError(state, envelope.id, {
								code: result.error?.code ?? "turn_failed",
								message: result.error?.message ?? "Turn execution failed",
							});
						}
						return;
					}

					// Validate controller lease fencing epoch AND controller connection identity
					this.validateController(state, threadId, epoch);

					const runtime = await this.ensureRuntime(threadId);
					const admitted = await runtime.startTurn(req.input, clientRequestId, epoch, state.id);

					const turnResult = {
						command: "turn/start" as const,
						status: "admitted" as const,
						turnId: admitted.turnId,
						admittedAt: admitted.admittedAt,
					};

					this.deduplicator.settle(dedupeKey, true, turnResult);
					await this.sendSuccess(state, envelope.id, turnResult);
					break;
				}

				case "turn/steer": {
					const threadId = asThreadId(req.threadId);
					const epoch = asControllerEpoch(req.controllerEpoch);
					this.validateController(state, threadId, epoch);
					const _runtime = await this.ensureRuntime(threadId);
					// Steer active turn
					await this.sendSuccess(state, envelope.id, {
						command: "turn/steer",
						status: "steered",
						turnId: req.turnId,
					});
					break;
				}

				case "turn/interrupt": {
					const threadId = asThreadId(req.threadId);
					const turnId = asTurnId(req.turnId);
					const epoch = asControllerEpoch(req.controllerEpoch);
					this.validateController(state, threadId, epoch);
					const runtime = await this.ensureRuntime(threadId);
					await (runtime as ThreadRuntimeImpl).interruptTurn(turnId, epoch);
					await this.sendSuccess(state, envelope.id, {
						command: "turn/interrupt",
						status: "interrupting",
						turnId: req.turnId,
					});
					break;
				}

				case "approval/respond": {
					const threadId = asThreadId(req.threadId);
					const epoch = asControllerEpoch(req.controllerEpoch);
					const clientRequestId = asClientRequestId(req.clientRequestId);

					const dedupeKey: DeduplicationKey = {
						principalId: state.id,
						threadId,
						method: "approval/respond",
						clientRequestId,
					};

					const dedupeStatus = this.deduplicator.checkOrAdmit(dedupeKey, req);
					if (dedupeStatus.type === "settled") {
						if (dedupeStatus.receipt.ok) {
							await this.sendSuccess(state, envelope.id, dedupeStatus.receipt.result as any);
						} else {
							await this.sendError(state, envelope.id, {
								code: dedupeStatus.receipt.error?.code ?? "approval_failed",
								message: dedupeStatus.receipt.error?.message ?? "Approval response failed",
							});
						}
						return;
					}

					if (dedupeStatus.type === "in_flight") {
						const result = await dedupeStatus.promise;
						if (result.ok) {
							await this.sendSuccess(state, envelope.id, result.result as any);
						} else {
							await this.sendError(state, envelope.id, {
								code: result.error?.code ?? "approval_failed",
								message: result.error?.message ?? "Approval response failed",
							});
						}
						return;
					}

					// Validate controller lease fencing epoch AND controller identity
					this.validateController(state, threadId, epoch);

					if (req.decision !== "approved" && req.decision !== "rejected") {
						await this.sendError(state, envelope.id, {
							code: "invalid_params",
							message: "Approval decision must be 'approved' or 'rejected'",
						});
						return;
					}

					// Resolve in approvalManager
					const resolved = this.approvalManager.resolve(req.requestId, req.decision);
					if (!resolved) {
						const err = {
							code: "approval_not_found",
							message: `Approval request '${req.requestId}' not found, expired, or already resolved`,
						};
						this.deduplicator.settle(dedupeKey, false, undefined, err);
						await this.sendError(state, envelope.id, err);
						return;
					}

					const resResult = {
						command: "approval/respond" as const,
						status: "resolved" as const,
						requestId: req.requestId,
						decision: req.decision,
					};

					this.deduplicator.settle(dedupeKey, true, resResult);
					await this.sendSuccess(state, envelope.id, resResult);
					break;
				}

				case "thread/watch": {
					const threadId = asThreadId(req.threadId);
					const runtime = await this.ensureRuntime(threadId);
					const result = await this.watchManager.watch(state.id, threadId, runtime, req.afterSeq, (msg) =>
						state.transport.send(msg),
					);
					await this.sendSuccess(state, envelope.id, result);
					break;
				}

				default:
					await this.sendError(state, envelope.id, {
						code: "not_implemented",
						message: `Command ${(req as any).command} is not implemented`,
					});
			}
		} catch (error) {
			const protocolError = this.toProtocolError(error);
			await this.sendError(state, envelope.id, protocolError);
		}
	}

	private async ensureRuntime(threadId: ThreadId): Promise<ThreadRuntime> {
		const existing = this.runtimeHost.getRuntime(threadId);
		if (existing) return existing;

		const pending = this.loadingRuntimes.get(threadId);
		if (pending) return pending;

		const loadPromise = (async () => {
			try {
				const residency = await this.runtimeHost.lifecycleCoordinator.startThread(threadId);
				let writer: JournalWriter;
				if (this.journalStore) {
					writer = await this.journalStore.open(threadId);
				} else {
					const store = new MemoryJournalStore();
					writer = await store.open(threadId);
				}

				let driver: AgentDriver;
				if (this.driverFactory) {
					driver = this.driverFactory(threadId);
				} else {
					driver = new FakeDriver("completed", "Default driver completed");
				}

				const newRuntime = new ThreadRuntimeImpl(threadId, residency.generation, writer, driver);
				this.runtimeHost.registerRuntime(newRuntime);
				return newRuntime;
			} finally {
				this.loadingRuntimes.delete(threadId);
			}
		})();

		this.loadingRuntimes.set(threadId, loadPromise);
		return loadPromise;
	}

	private validateController(
		state: ServerConnectionState,
		threadId: ThreadId,
		epoch: ControllerEpoch,
	): ControllerLease {
		const lease = this.leaseManager.validateEpoch(threadId, epoch);
		if (!state.leasedThreads.has(threadId) && lease.controllerId !== state.id) {
			throw new ControllerFencingError(
				`Controller mismatch on thread ${threadId}: command from ${state.id}, current lease held by ${lease.controllerId}`,
				{ threadId, controllerId: state.id, activeControllerId: lease.controllerId },
			);
		}
		return lease;
	}

	private toProtocolError(error: unknown): ProtocolV2Error {
		if (error instanceof ControllerFencingError) {
			return {
				code: "controller_fencing_error",
				message: error.message,
				details: error.details,
			};
		}
		if (error instanceof CommandDeduplicationConflictError) {
			return {
				code: "deduplication_conflict",
				message: error.message,
				details: error.details,
			};
		}
		if (error instanceof ActiveTurnConflictError) {
			return {
				code: "active_turn_conflict",
				message: error.message,
				details: error.details,
			};
		}
		return {
			code: "internal_error",
			message: error instanceof Error ? error.message : String(error),
		};
	}

	private sendSuccess(state: ServerConnectionState, id: any, result: any): Promise<boolean> {
		const response: ProtocolV2ResponseEnvelope = {
			type: "response",
			id,
			ok: true,
			result,
		};
		return state.transport.send(response as ServerMessageV2);
	}

	private sendError(state: ServerConnectionState, id: any, error: ProtocolV2Error): Promise<boolean> {
		const response: ProtocolV2ResponseEnvelope = {
			type: "response",
			id,
			ok: false,
			error,
		};
		return state.transport.send(response as ServerMessageV2);
	}

	private async failHandshake(state: ServerConnectionState, code: string, message: string): Promise<void> {
		if (state.stage === "closed") return;
		state.stage = "closed";

		if (state.handshakeTimer) {
			clearTimeout(state.handshakeTimer);
			state.handshakeTimer = undefined;
		}

		const errorMsg: ServerMessageV2 = {
			type: "hello_error",
			protocolVersion: PROTOCOL_V2_VERSION,
			code,
			message,
		};

		try {
			await state.transport.send(errorMsg);
		} catch {
			// Suppress send errors on failure
		}

		await state.transport.close();
		this.handleConnectionClose(state);
	}

	private handleConnectionClose(state: ServerConnectionState): void {
		if (state.stage === "closed") return;
		state.stage = "closed";

		if (state.handshakeTimer) {
			clearTimeout(state.handshakeTimer);
			state.handshakeTimer = undefined;
		}

		this.connections.delete(state.id);
		this.watchManager.unwatch(state.id);

		// Revoke any controller leases held by this disconnected client
		for (const threadId of state.leasedThreads) {
			const activeLease = this.leaseManager.getActiveLease(threadId);
			if (activeLease && activeLease.controllerId === state.id) {
				this.leaseManager.release(threadId, activeLease.controllerId, asControllerEpoch(activeLease.epoch));
			}
		}
		state.leasedThreads.clear();
	}

	private setupApprovalBroadcaster(): void {
		if (this.approvalManager instanceof ApprovalManagerImpl) {
			this.approvalManager.onRequest(async (req) => {
				if (!req.threadId) return;
				const runtime = await this.ensureRuntime(req.threadId);
				if (runtime && "broadcastWireEvent" in runtime) {
					const wireEvent: WireEventEnvelope = {
						eventId: asEventId(`evt_appr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`),
						threadId: req.threadId,
						seq: Date.now(),
						type: "approval.requested",
						payload: {
							requestId: req.requestId,
							turnId: req.turnId,
							toolAttemptId: req.toolAttemptId,
							toolName: req.toolName,
							fingerprint: req.fingerprint,
							description: req.description,
							expiresAt: req.expiresAt,
							controllerEpoch: req.controllerEpoch,
						},
						timestamp: Date.now(),
					};
					(runtime as ThreadRuntimeImpl).broadcastWireEvent(wireEvent);
				}
			});

			this.approvalManager.onResolved(async (req, decision, reason) => {
				const threadId = (req as any).threadId as ThreadId | undefined;
				if (!threadId) return;
				const runtime = await this.ensureRuntime(threadId);
				if (runtime && "broadcastWireEvent" in runtime) {
					const wireEvent: WireEventEnvelope = {
						eventId: asEventId(`evt_appr_res_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`),
						threadId,
						seq: Date.now(),
						type: "approval.resolved",
						payload: {
							requestId: req.requestId,
							turnId: req.turnId,
							decision,
							reason,
							controllerEpoch: (req as any).controllerEpoch,
						},
						timestamp: Date.now(),
					};
					(runtime as ThreadRuntimeImpl).broadcastWireEvent(wireEvent);
				}
			});
		}
	}

	async close(): Promise<void> {
		if (this.isClosing) return;
		this.isClosing = true;

		for (const state of Array.from(this.connections.values())) {
			await state.transport.close();
			this.handleConnectionClose(state);
		}

		this.connections.clear();
		this.watchManager.dispose();
		this.leaseManager.dispose();
	}
}
