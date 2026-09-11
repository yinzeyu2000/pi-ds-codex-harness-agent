import type { ThreadId } from "@earendil-works/pi-protocol";
import type { ApprovalManager, ApprovalRequest } from "../types/providers.ts";
import { normalizePathSeparators } from "./policy.ts";
import type { ApprovalFingerprintInput } from "./types.ts";

function canonicalJsonStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}

	if (Array.isArray(value)) {
		const items = value.map((item) => canonicalJsonStringify(item));
		return `[${items.join(",")}]`;
	}

	const obj = value as Record<string, unknown>;
	const sortedKeys = Object.keys(obj).sort();
	const entries = sortedKeys.map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify(obj[key])}`);
	return `{${entries.join(",")}}`;
}

export async function computeApprovalFingerprint(input: ApprovalFingerprintInput): Promise<string> {
	const normalized = {
		threadId: input.threadId,
		turnId: input.turnId,
		toolAttemptId: input.toolAttemptId,
		toolName: input.toolName,
		command: input.command ?? "",
		args: input.args ? [...input.args] : [],
		cwd: input.cwd ? normalizePathSeparators(input.cwd).toLowerCase() : "",
		readRoots: input.readRoots ? input.readRoots.map((r) => normalizePathSeparators(r).toLowerCase()).sort() : [],
		writeRoots: input.writeRoots ? input.writeRoots.map((r) => normalizePathSeparators(r).toLowerCase()).sort() : [],
		network: input.network ?? { allowNetwork: false },
		sandboxMode: input.sandboxMode ?? "secure",
		controllerEpoch: input.controllerEpoch ?? 0,
	};

	const canonical = canonicalJsonStringify(normalized);
	const data = new TextEncoder().encode(canonical);

	if (typeof globalThis.crypto?.subtle?.digest === "function") {
		const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", data);
		const hashArray = Array.from(new Uint8Array(hashBuf));
		return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
	}

	// Fallback 64-bit FNV-1a if subtle crypto is unavailable in test environment
	let hash = 14695981039346656037n;
	const FNV_PRIME = 1099511628211n;
	const MASK64 = 0xffffffffffffffffn;
	for (let i = 0; i < data.length; i++) {
		hash ^= BigInt(data[i]);
		hash = (hash * FNV_PRIME) & MASK64;
	}
	return hash.toString(16).padStart(64, "0");
}

interface PendingApprovalEntry {
	readonly request: ApprovalRequest;
	readonly threadId?: ThreadId;
	readonly controllerEpoch?: number;
	readonly resolve: (decision: "approved" | "rejected" | "expired") => void;
	readonly timer?: ReturnType<typeof setTimeout>;
}

export class ApprovalManagerImpl implements ApprovalManager {
	private readonly pendingRequests = new Map<string, PendingApprovalEntry>();
	private readonly defaultTimeoutMs: number;
	private readonly requestListeners = new Set<
		(req: ApprovalRequest & { threadId?: ThreadId; controllerEpoch?: number }) => void
	>();
	private readonly resolveListeners = new Set<
		(req: ApprovalRequest, decision: "approved" | "rejected" | "expired", reason?: string) => void
	>();

	constructor(defaultTimeoutMs = 60000) {
		this.defaultTimeoutMs = defaultTimeoutMs;
	}

	onRequest(listener: (req: ApprovalRequest & { threadId?: ThreadId; controllerEpoch?: number }) => void): {
		dispose: () => void;
	} {
		this.requestListeners.add(listener);
		return {
			dispose: () => {
				this.requestListeners.delete(listener);
			},
		};
	}

	onResolved(
		listener: (req: ApprovalRequest, decision: "approved" | "rejected" | "expired", reason?: string) => void,
	): { dispose: () => void } {
		this.resolveListeners.add(listener);
		return {
			dispose: () => {
				this.resolveListeners.delete(listener);
			},
		};
	}

	get pendingCount(): number {
		return this.pendingRequests.size;
	}

	getPendingRequest(requestId: string): ApprovalRequest | undefined {
		return this.pendingRequests.get(requestId)?.request;
	}

	async requestApproval(
		request: ApprovalRequest & { threadId?: ThreadId; controllerEpoch?: number },
		signal?: AbortSignal,
	): Promise<"approved" | "rejected" | "expired"> {
		if (signal?.aborted) {
			return "rejected";
		}

		return new Promise<"approved" | "rejected" | "expired">((resolve) => {
			const now = Date.now();
			const timeoutDuration = Math.max(0, (request.expiresAt ?? now + this.defaultTimeoutMs) - now);

			let timer: ReturnType<typeof setTimeout> | undefined;
			if (timeoutDuration > 0) {
				timer = setTimeout(() => {
					this.resolveInternal(request.requestId, "expired");
				}, timeoutDuration);
				if (typeof timer.unref === "function") {
					timer.unref();
				}
			}

			const onAbort = () => {
				this.cancel(request.requestId, "aborted");
			};

			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
			}

			const entry: PendingApprovalEntry = {
				request,
				threadId: request.threadId,
				controllerEpoch: request.controllerEpoch,
				resolve: (decision) => {
					if (timer) clearTimeout(timer);
					if (signal) signal.removeEventListener("abort", onAbort);
					resolve(decision);
				},
				timer,
			};

			this.pendingRequests.set(request.requestId, entry);

			// Notify listeners of incoming approval request
			for (const listener of this.requestListeners) {
				try {
					listener(request);
				} catch {
					// Prevent listener error from disrupting flow
				}
			}
		});
	}

	resolve(requestId: string, decision: "approved" | "rejected", providedFingerprint?: string): boolean {
		const entry = this.pendingRequests.get(requestId);
		if (!entry) return false;

		// Fingerprint verification on resolution
		if (providedFingerprint && providedFingerprint !== entry.request.fingerprint) {
			// Fingerprint mismatch: force rejection fail-closed
			this.resolveInternal(requestId, "rejected");
			return false;
		}

		return this.resolveInternal(requestId, decision);
	}

	cancel(requestId: string, _reason?: string): boolean {
		return this.resolveInternal(requestId, "rejected");
	}

	cancelAllForThread(threadId: ThreadId, _reason?: string): number {
		let cancelledCount = 0;
		for (const [id, entry] of this.pendingRequests.entries()) {
			if (entry.threadId === threadId) {
				this.resolveInternal(id, "rejected");
				cancelledCount++;
			}
		}
		return cancelledCount;
	}

	private resolveInternal(requestId: string, decision: "approved" | "rejected" | "expired", reason?: string): boolean {
		const entry = this.pendingRequests.get(requestId);
		if (!entry) return false;

		this.pendingRequests.delete(requestId);
		entry.resolve(decision);

		for (const listener of this.resolveListeners) {
			try {
				listener(entry.request, decision, reason);
			} catch {
				// Prevent listener error from disrupting flow
			}
		}

		return true;
	}

	async verifyPreExecutionFingerprint(
		approvedRequest: ApprovalRequest,
		currentInput: ApprovalFingerprintInput,
	): Promise<boolean> {
		const currentFingerprint = await computeApprovalFingerprint(currentInput);
		return currentFingerprint === approvedRequest.fingerprint;
	}
}
