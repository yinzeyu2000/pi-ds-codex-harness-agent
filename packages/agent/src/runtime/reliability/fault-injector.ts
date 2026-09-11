import type { PreparedAction, ToolExecutionContext, ToolExecutionOutcome } from "../types/execution-broker.ts";

export type FaultPoint =
	| "broker:before_prepare"
	| "broker:before_execute"
	| "broker:during_execute"
	| "broker:after_execute"
	| "journal:before_append"
	| "journal:after_append"
	| "approval:before_request"
	| "approval:after_resolve"
	| "transport:before_send"
	| "transport:after_receive";

export interface InjectedFault {
	readonly point: FaultPoint;
	readonly count?: number;
	readonly error?: Error;
	readonly delayMs?: number;
	readonly match?: (context: unknown) => boolean;
	readonly action?: (context: unknown) => Promise<void> | void;
}

export class FaultInjector {
	private readonly faults: InjectedFault[] = [];
	private readonly triggerCounts: Map<string, number> = new Map();

	inject(fault: InjectedFault): this {
		this.faults.push(fault);
		return this;
	}

	clear(): void {
		this.faults.length = 0;
		this.triggerCounts.clear();
	}

	getTriggerCount(point: FaultPoint): number {
		return this.triggerCounts.get(point) ?? 0;
	}

	async maybeTrigger(point: FaultPoint, context?: unknown): Promise<void> {
		for (let i = 0; i < this.faults.length; i++) {
			const fault = this.faults[i];
			if (fault.point !== point) {
				continue;
			}

			if (fault.match && !fault.match(context)) {
				continue;
			}

			const currentCount = this.triggerCounts.get(point) ?? 0;
			if (fault.count !== undefined && currentCount >= fault.count) {
				continue;
			}

			this.triggerCounts.set(point, currentCount + 1);

			if (fault.delayMs && fault.delayMs > 0) {
				await new Promise<void>((resolve) => setTimeout(resolve, fault.delayMs));
			}

			if (fault.action) {
				await fault.action(context);
			}

			if (fault.error) {
				throw fault.error;
			}
		}
	}
}

/**
 * Creates an ExecutionBroker proxy or decorator that intercepts action preparation
 * and execution with deterministic fault injection hooks.
 */
export interface FaultInjectableBrokerHooks {
	readonly injector: FaultInjector;
}

export function wrapBrokerWithFaultInjector<
	T extends {
		prepareAction: (toolName: string, params: unknown, context: ToolExecutionContext) => Promise<PreparedAction>;
		executeAction: (action: PreparedAction, context: ToolExecutionContext) => Promise<ToolExecutionOutcome>;
	},
>(broker: T, injector: FaultInjector): T {
	const originalPrepare = broker.prepareAction.bind(broker);
	const originalExecute = broker.executeAction.bind(broker);

	broker.prepareAction = async (toolName: string, params: unknown, context: ToolExecutionContext) => {
		await injector.maybeTrigger("broker:before_prepare", { toolName, params, context });
		return originalPrepare(toolName, params, context);
	};

	broker.executeAction = async (action: PreparedAction, context: ToolExecutionContext) => {
		try {
			await injector.maybeTrigger("broker:before_execute", { action, context });
			await injector.maybeTrigger("broker:during_execute", { action, context });
			const outcome = await originalExecute(action, context);
			await injector.maybeTrigger("broker:after_execute", { action, context, outcome });
			return outcome;
		} catch (err) {
			const failedOutcome: ToolExecutionOutcome = {
				toolAttemptId: context.toolAttemptId,
				status: "failed",
				error: err instanceof Error ? err.message : String(err),
				durationMs: 0,
			};
			return failedOutcome;
		}
	};

	return broker;
}
