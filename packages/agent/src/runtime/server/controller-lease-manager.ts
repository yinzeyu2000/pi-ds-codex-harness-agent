import {
	asControllerEpoch,
	type ControllerEpoch,
	type ControllerLease,
	type ThreadId,
} from "@earendil-works/pi-protocol";
import { ControllerFencingError } from "../types/errors.ts";

export type LeaseRevocationListener = (
	revokedLease: ControllerLease,
	reason: "released" | "expired" | "superseded",
) => void;

export class ControllerLeaseManager {
	private readonly leases = new Map<string, ControllerLease>();
	private readonly epochCounters = new Map<string, number>();
	private readonly listeners = new Map<string, Set<LeaseRevocationListener>>();
	private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly globalListeners = new Set<
		(threadId: ThreadId, lease: ControllerLease, reason: "released" | "expired" | "superseded") => void
	>();

	onAnyLeaseRevoked(
		listener: (threadId: ThreadId, lease: ControllerLease, reason: "released" | "expired" | "superseded") => void,
	): { dispose: () => void } {
		this.globalListeners.add(listener);
		return {
			dispose: () => {
				this.globalListeners.delete(listener);
			},
		};
	}

	onLeaseRevoked(threadId: ThreadId, listener: LeaseRevocationListener): { dispose: () => void } {
		let set = this.listeners.get(threadId);
		if (!set) {
			set = new Set();
			this.listeners.set(threadId, set);
		}
		set.add(listener);

		return {
			dispose: () => {
				set?.delete(listener);
			},
		};
	}

	private notifyRevoked(
		threadId: ThreadId,
		lease: ControllerLease,
		reason: "released" | "expired" | "superseded",
	): void {
		for (const listener of this.globalListeners) {
			try {
				listener(threadId, lease, reason);
			} catch {
				// Observer error must not disrupt lease state machine
			}
		}

		const set = this.listeners.get(threadId);
		if (set) {
			for (const listener of set) {
				try {
					listener(lease, reason);
				} catch {
					// Observer error must not disrupt lease state machine
				}
			}
		}
	}

	acquire(threadId: ThreadId, controllerId: string, ttlMs = 60000): ControllerLease {
		const currentCounter = this.epochCounters.get(threadId) ?? 0;
		const nextEpochNum = currentCounter + 1;
		this.epochCounters.set(threadId, nextEpochNum);
		const epoch = asControllerEpoch(nextEpochNum);

		const oldLease = this.leases.get(threadId);
		const existingTimer = this.expiryTimers.get(threadId);
		if (existingTimer) {
			clearTimeout(existingTimer);
			this.expiryTimers.delete(threadId);
		}

		if (oldLease) {
			this.notifyRevoked(threadId, oldLease, "superseded");
		}

		const now = Date.now();
		const lease: ControllerLease = {
			threadId,
			controllerId,
			epoch,
			acquiredAt: now,
			expiresAt: now + ttlMs,
		};

		this.leases.set(threadId, lease);

		// Schedule expiry timer
		const timer = setTimeout(() => {
			this.handleExpiry(threadId, epoch);
		}, ttlMs);
		if (typeof timer.unref === "function") {
			timer.unref();
		}
		this.expiryTimers.set(threadId, timer);

		return lease;
	}

	renew(threadId: ThreadId, controllerId: string, epoch: ControllerEpoch, ttlMs = 60000): ControllerLease {
		const lease = this.getActiveLease(threadId);
		if (!lease) {
			throw new ControllerFencingError(
				`Cannot renew lease for thread ${threadId}: no active controller lease exists`,
				{ threadId, epoch },
			);
		}

		if (lease.controllerId !== controllerId || lease.epoch !== epoch) {
			throw new ControllerFencingError(
				`Cannot renew lease for thread ${threadId}: controller or epoch mismatch (expected ${lease.controllerId}@${lease.epoch}, got ${controllerId}@${epoch})`,
				{
					expectedController: lease.controllerId,
					expectedEpoch: lease.epoch,
					gotController: controllerId,
					gotEpoch: epoch,
				},
			);
		}

		const existingTimer = this.expiryTimers.get(threadId);
		if (existingTimer) {
			clearTimeout(existingTimer);
		}

		const now = Date.now();
		const renewed: ControllerLease = {
			threadId,
			controllerId,
			epoch,
			acquiredAt: lease.acquiredAt,
			expiresAt: now + ttlMs,
		};

		this.leases.set(threadId, renewed);

		const timer = setTimeout(() => {
			this.handleExpiry(threadId, epoch);
		}, ttlMs);
		if (typeof timer.unref === "function") {
			timer.unref();
		}
		this.expiryTimers.set(threadId, timer);

		return renewed;
	}

	release(threadId: ThreadId, controllerId: string, epoch: ControllerEpoch): boolean {
		const lease = this.leases.get(threadId);
		if (!lease || lease.controllerId !== controllerId || lease.epoch !== epoch) {
			return false;
		}

		const existingTimer = this.expiryTimers.get(threadId);
		if (existingTimer) {
			clearTimeout(existingTimer);
			this.expiryTimers.delete(threadId);
		}

		this.leases.delete(threadId);
		this.notifyRevoked(threadId, lease, "released");
		return true;
	}

	validateEpoch(threadId: ThreadId, epoch: ControllerEpoch, controllerId?: string): ControllerLease {
		const lease = this.getActiveLease(threadId);
		if (!lease) {
			throw new ControllerFencingError(
				`Command rejected: thread ${threadId} has no active controller lease (required epoch ${epoch})`,
				{ threadId, requiredEpoch: epoch },
			);
		}

		if (lease.epoch !== epoch) {
			throw new ControllerFencingError(
				`Fencing violation on thread ${threadId}: command carries stale epoch ${epoch}, current active epoch is ${lease.epoch}`,
				{ threadId, requiredEpoch: epoch, activeEpoch: lease.epoch },
			);
		}

		if (controllerId !== undefined && lease.controllerId !== controllerId) {
			throw new ControllerFencingError(
				`Controller mismatch on thread ${threadId}: command from ${controllerId}, current lease held by ${lease.controllerId}`,
				{ threadId, controllerId, activeControllerId: lease.controllerId },
			);
		}

		return lease;
	}

	getActiveLease(threadId: ThreadId): ControllerLease | undefined {
		const lease = this.leases.get(threadId);
		if (!lease) return undefined;

		if (Date.now() > lease.expiresAt) {
			this.handleExpiry(threadId, asControllerEpoch(lease.epoch));
			return undefined;
		}

		return lease;
	}

	private handleExpiry(threadId: ThreadId, epoch: ControllerEpoch): void {
		const lease = this.leases.get(threadId);
		if (lease && lease.epoch === epoch) {
			this.leases.delete(threadId);
			const timer = this.expiryTimers.get(threadId);
			if (timer) {
				clearTimeout(timer);
				this.expiryTimers.delete(threadId);
			}
			this.notifyRevoked(threadId, lease, "expired");
		}
	}

	dispose(): void {
		for (const timer of this.expiryTimers.values()) {
			clearTimeout(timer);
		}
		this.expiryTimers.clear();
		this.leases.clear();
		this.listeners.clear();
	}
}
