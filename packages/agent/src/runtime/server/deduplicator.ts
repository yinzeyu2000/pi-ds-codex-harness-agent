import {
	asCommandId,
	type CommandAdmissionReceipt,
	type CommandResultReceipt,
	computePayloadHash,
	type DeduplicationKey,
	formatDeduplicationKey,
} from "@earendil-works/pi-protocol";
import { CommandDeduplicationConflictError } from "../types/errors.ts";

export interface InFlightEntry {
	readonly admission: CommandAdmissionReceipt;
	status: "admitted" | "executing" | "completed" | "failed";
	resultReceipt?: CommandResultReceipt;
	promise?: Promise<CommandResultReceipt>;
	resolvePromise?: (receipt: CommandResultReceipt) => void;
	rejectPromise?: (err: Error) => void;
}

export type DeduplicationStatus =
	| { readonly type: "new"; readonly admission: CommandAdmissionReceipt }
	| { readonly type: "in_flight"; readonly promise: Promise<CommandResultReceipt> }
	| { readonly type: "settled"; readonly receipt: CommandResultReceipt };

export class CommandDeduplicator {
	private readonly entries = new Map<string, InFlightEntry>();
	private readonly keyOrder: string[] = [];
	private readonly maxEntries: number;

	constructor(maxEntries = 5000) {
		this.maxEntries = maxEntries;
	}

	get size(): number {
		return this.entries.size;
	}

	checkOrAdmit(key: DeduplicationKey, payload: unknown): DeduplicationStatus {
		const keyStr = formatDeduplicationKey(key);
		const hash = computePayloadHash(payload);

		const existing = this.entries.get(keyStr);
		if (existing) {
			if (existing.admission.payloadHash !== hash) {
				throw new CommandDeduplicationConflictError(
					`Payload hash conflict for clientRequestId ${key.clientRequestId} on thread ${key.threadId} method ${key.method}`,
					{
						dedupeKey: keyStr,
						existingHash: existing.admission.payloadHash,
						incomingHash: hash,
					},
				);
			}

			if (existing.status === "completed" || existing.status === "failed") {
				if (existing.resultReceipt) {
					return { type: "settled", receipt: existing.resultReceipt };
				}
			}

			if (existing.promise) {
				return { type: "in_flight", promise: existing.promise };
			}
		}

		// Clean capacity if needed
		if (this.entries.size >= this.maxEntries) {
			this.evictOldestSettled();
		}

		let resolvePromise!: (receipt: CommandResultReceipt) => void;
		let rejectPromise!: (err: Error) => void;
		const promise = new Promise<CommandResultReceipt>((resolve, reject) => {
			resolvePromise = resolve;
			rejectPromise = reject;
		});

		const now = Date.now();
		const commandId = asCommandId(`cmd_${now}_${Math.random().toString(36).slice(2, 7)}`);

		const admission: CommandAdmissionReceipt = {
			commandId,
			principalId: key.principalId,
			threadId: key.threadId,
			method: key.method,
			clientRequestId: key.clientRequestId,
			payloadHash: hash,
			admittedAt: now,
			status: "admitted",
		};

		const entry: InFlightEntry = {
			admission,
			status: "admitted",
			promise,
			resolvePromise,
			rejectPromise,
		};

		this.entries.set(keyStr, entry);
		this.keyOrder.push(keyStr);

		return { type: "new", admission };
	}

	settle(
		key: DeduplicationKey,
		ok: boolean,
		result?: unknown,
		error?: { code: string; message: string },
	): CommandResultReceipt {
		const keyStr = formatDeduplicationKey(key);
		const entry = this.entries.get(keyStr);
		const now = Date.now();

		const commandId = entry ? entry.admission.commandId : asCommandId(`cmd_${now}`);
		const payloadHash = entry ? entry.admission.payloadHash : "";

		const receipt: CommandResultReceipt = {
			commandId,
			principalId: key.principalId,
			threadId: key.threadId,
			method: key.method,
			clientRequestId: key.clientRequestId,
			payloadHash,
			completedAt: now,
			ok,
			result,
			error,
		};

		if (entry) {
			entry.status = ok ? "completed" : "failed";
			entry.resultReceipt = receipt;
			if (entry.resolvePromise) {
				entry.resolvePromise(receipt);
			}
		}

		return receipt;
	}

	getReceipt(key: DeduplicationKey): CommandResultReceipt | undefined {
		const keyStr = formatDeduplicationKey(key);
		return this.entries.get(keyStr)?.resultReceipt;
	}

	private evictOldestSettled(): void {
		let removeIndex = -1;
		for (let i = 0; i < this.keyOrder.length; i++) {
			const k = this.keyOrder[i];
			const e = this.entries.get(k);
			if (e && (e.status === "completed" || e.status === "failed")) {
				removeIndex = i;
				this.entries.delete(k);
				break;
			}
		}
		if (removeIndex !== -1) {
			this.keyOrder.splice(removeIndex, 1);
		} else if (this.keyOrder.length > 0) {
			const k = this.keyOrder.shift()!;
			this.entries.delete(k);
		}
	}

	clear(): void {
		this.entries.clear();
		this.keyOrder.length = 0;
	}
}
