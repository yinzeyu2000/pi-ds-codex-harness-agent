import type { ThreadId } from "@earendil-works/pi-protocol";
import type { AgentTool } from "../../types.ts";
import { computeApprovalFingerprint } from "../security/approval.ts";
import type { ApprovalFingerprintInput, PermissionProfile, PolicyEngine, SandboxMode } from "../security/types.ts";
import type {
	ActionKind,
	ExecutionBroker,
	PreparedAction,
	ToolAttemptCoordinator,
	ToolExecutionContext,
	ToolExecutionOutcome,
} from "../types/execution-broker.ts";
import type {
	ApprovalManager,
	ApprovalRequest,
	ProcessOutcome,
	ProcessSpec,
	ProcessSupervisor,
	SandboxPolicy,
	SandboxProvider,
	WorkspaceFSProvider,
} from "../types/providers.ts";

export interface ExecutionBrokerOptions {
	readonly coordinator?: ToolAttemptCoordinator;
	readonly supervisor?: ProcessSupervisor;
	readonly workspaceFS?: WorkspaceFSProvider;
	readonly tools?: ReadonlyMap<string, AgentTool>;
	readonly policyChecker?: (action: PreparedAction, context: ToolExecutionContext) => Promise<boolean> | boolean;
	readonly policyEngine?: PolicyEngine;
	readonly permissionProfile?: PermissionProfile;
	readonly approvalManager?: ApprovalManager;
	readonly sandboxProvider?: SandboxProvider;
	readonly sandboxMode?: SandboxMode;
}

export class ExecutionBrokerImpl implements ExecutionBroker {
	private readonly coordinator?: ToolAttemptCoordinator;
	private readonly supervisor?: ProcessSupervisor;
	private readonly workspaceFS?: WorkspaceFSProvider;
	private readonly tools: Map<string, AgentTool>;
	private readonly policyChecker?: (
		action: PreparedAction,
		context: ToolExecutionContext,
	) => Promise<boolean> | boolean;
	private readonly policyEngine?: PolicyEngine;
	private readonly permissionProfile?: PermissionProfile;
	private readonly approvalManager?: ApprovalManager;
	private readonly sandboxProvider?: SandboxProvider;
	private readonly sandboxMode?: SandboxMode;

	constructor(options?: ExecutionBrokerOptions) {
		this.coordinator = options?.coordinator;
		this.supervisor = options?.supervisor;
		this.workspaceFS = options?.workspaceFS;
		this.tools = new Map(options?.tools ?? []);
		this.policyChecker = options?.policyChecker;
		this.policyEngine = options?.policyEngine;
		this.permissionProfile = options?.permissionProfile;
		this.approvalManager = options?.approvalManager;
		this.sandboxProvider = options?.sandboxProvider;
		this.sandboxMode = options?.sandboxMode;
	}

	registerTool(tool: AgentTool): void {
		this.tools.set(tool.name, tool);
	}

	async prepareAction(toolName: string, input: unknown, _context: ToolExecutionContext): Promise<PreparedAction> {
		let kind: ActionKind = "compute";
		let paths: string[] | undefined;

		if (toolName === "bash" || toolName === "shell" || toolName === "exec" || toolName === "powershell") {
			kind = "process";
			const cmd = (input as any)?.command ?? (input as any)?.cmd;
			if (cmd) {
				paths = [String(cmd)];
			}
		} else if (
			toolName.includes("read") ||
			toolName.includes("grep") ||
			toolName.includes("find") ||
			toolName.includes("ls")
		) {
			kind = "fs_read";
			const p = (input as any)?.path ?? (input as any)?.directory;
			if (p) paths = [String(p)];
		} else if (toolName.includes("edit") || toolName.includes("replace")) {
			kind = "fs_edit";
			const p = (input as any)?.path;
			if (p) paths = [String(p)];
		} else if (toolName.includes("write")) {
			kind = "fs_write";
			const p = (input as any)?.path;
			if (p) paths = [String(p)];
		}

		return {
			kind,
			toolName,
			payload: input,
			paths,
		};
	}

	async executeAction(action: PreparedAction, context: ToolExecutionContext): Promise<ToolExecutionOutcome> {
		const start = Date.now();

		// Step 1: Attempt prepared
		if (this.coordinator) {
			await this.coordinator.onAttemptPrepared(context.toolAttemptId, action);
		}

		// Step 2: Policy & Approval Pipeline
		if (this.policyEngine) {
			const decision = await this.policyEngine.evaluate({
				action,
				executionContext: context,
				profile: this.permissionProfile,
			});

			if (decision.decision === "deny") {
				const deniedOutcome: ToolExecutionOutcome = {
					toolAttemptId: context.toolAttemptId,
					status: "denied",
					error: decision.reason,
					durationMs: Date.now() - start,
				};
				if (this.coordinator) {
					await this.coordinator.onAttemptSettled(context.toolAttemptId, deniedOutcome);
				}
				return deniedOutcome;
			}

			if (decision.decision === "requires_approval") {
				if (!this.approvalManager) {
					// Fail closed: approval required but no approval manager configured
					const deniedOutcome: ToolExecutionOutcome = {
						toolAttemptId: context.toolAttemptId,
						status: "denied",
						error: "Action requires approval, but no ApprovalManager is configured; failing closed",
						durationMs: Date.now() - start,
					};
					if (this.coordinator) {
						await this.coordinator.onAttemptSettled(context.toolAttemptId, deniedOutcome);
					}
					return deniedOutcome;
				}

				const params = action.payload as
					| { command?: string; cmd?: string; args?: string[]; cwd?: string }
					| undefined;
				const command = params?.command ?? params?.cmd;
				const args = params?.args;
				const cwd = params?.cwd;

				const fingerprintInput: ApprovalFingerprintInput = {
					threadId: context.threadId ? String(context.threadId) : "default_thread",
					turnId: String(context.turnId),
					toolAttemptId: String(context.toolAttemptId),
					toolName: action.toolName,
					command,
					args,
					cwd,
					readRoots: this.permissionProfile?.filesystem?.readRoots,
					writeRoots: this.permissionProfile?.filesystem?.writeRoots,
					network: this.permissionProfile?.network,
					sandboxMode: this.sandboxMode ?? "secure",
					controllerEpoch: context.controllerEpoch !== undefined ? Number(context.controllerEpoch) : undefined,
				};

				const fingerprint = await computeApprovalFingerprint(fingerprintInput);
				const reqId = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
				const approvalRequest: ApprovalRequest & { threadId?: ThreadId; controllerEpoch?: number } = {
					requestId: reqId,
					turnId: context.turnId,
					toolAttemptId: context.toolAttemptId,
					toolName: action.toolName,
					fingerprint,
					description: decision.promptMessage ?? `Execute ${action.toolName}`,
					expiresAt: Date.now() + 60000,
					threadId: context.threadId,
					controllerEpoch: context.controllerEpoch !== undefined ? Number(context.controllerEpoch) : undefined,
				};

				const resolution = await this.approvalManager.requestApproval(approvalRequest, context.signal);
				if (resolution !== "approved") {
					const deniedOutcome: ToolExecutionOutcome = {
						toolAttemptId: context.toolAttemptId,
						status: "denied",
						error: `Approval resolution: ${resolution}`,
						durationMs: Date.now() - start,
					};
					if (this.coordinator) {
						await this.coordinator.onAttemptSettled(context.toolAttemptId, deniedOutcome);
					}
					return deniedOutcome;
				}

				// TOCTOU check: recompute fingerprint right before dispatch
				const currentFingerprint = await computeApprovalFingerprint(fingerprintInput);
				if (currentFingerprint !== fingerprint) {
					const deniedOutcome: ToolExecutionOutcome = {
						toolAttemptId: context.toolAttemptId,
						status: "denied",
						error: "TOCTOU violation: approval fingerprint mismatch right before execution",
						durationMs: Date.now() - start,
					};
					if (this.coordinator) {
						await this.coordinator.onAttemptSettled(context.toolAttemptId, deniedOutcome);
					}
					return deniedOutcome;
				}
			}
		} else if (this.policyChecker) {
			const allowed = await this.policyChecker(action, context);
			if (!allowed) {
				const deniedOutcome: ToolExecutionOutcome = {
					toolAttemptId: context.toolAttemptId,
					status: "denied",
					error: "Action denied by security policy or approval",
					durationMs: Date.now() - start,
				};
				if (this.coordinator) {
					await this.coordinator.onAttemptSettled(context.toolAttemptId, deniedOutcome);
				}
				return deniedOutcome;
			}
		}

		// Step 3: Write-before-execute barrier
		if (this.coordinator) {
			await this.coordinator.onDispatchIntent(context.toolAttemptId);
		}

		// Step 4: Execution started
		if (this.coordinator) {
			await this.coordinator.onExecutionStarted(context.toolAttemptId);
		}

		try {
			let output: unknown;

			// Step 5: Route to ProcessSupervisor or AgentTool
			if (action.kind === "process" && this.supervisor) {
				const params = action.payload as
					| { command?: string; cmd?: string; args?: string[]; cwd?: string; timeoutMs?: number }
					| undefined;
				let spec: ProcessSpec;

				if (params?.command && Array.isArray(params.args)) {
					spec = {
						command: params.command,
						args: params.args,
						cwd: params.cwd,
						timeoutMs: params.timeoutMs,
					};
				} else {
					const commandStr: string = params?.command ?? params?.cmd ?? String(params ?? "");
					spec = {
						command: process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh",
						args: process.platform === "win32" ? ["/d", "/s", "/c", commandStr] : ["-c", commandStr],
						cwd: params?.cwd,
						timeoutMs: params?.timeoutMs,
					};
				}

				// Apply Sandbox Provider if configured
				if (this.sandboxProvider) {
					const sandboxPolicy: SandboxPolicy = {
						allowWorkspaceOnly: this.permissionProfile?.filesystem !== undefined,
						allowNetwork: this.permissionProfile?.network?.allowNetwork ?? false,
						allowedHosts: this.permissionProfile?.network?.allowedHosts,
					};
					const wrapped = await this.sandboxProvider.wrapCommand(spec.command, spec.args, sandboxPolicy);
					spec = {
						command: wrapped.command,
						args: wrapped.args,
						cwd: spec.cwd,
						timeoutMs: spec.timeoutMs,
					};
				}

				const handle = await this.supervisor.spawn(spec, context.signal);

				const processOutcome: ProcessOutcome = await handle.wait();
				const outputBatch = await this.supervisor.read(handle.processId);
				const chunks = (outputBatch?.chunks ?? []) as Array<{ stream: string; data: string }>;
				const stdoutText = chunks
					.filter((c) => c.stream === "stdout")
					.map((c) => c.data)
					.join("");
				const stderrText = chunks
					.filter((c) => c.stream === "stderr")
					.map((c) => c.data)
					.join("");

				output = {
					stdout: stdoutText,
					stderr: stderrText,
					exitCode: processOutcome.exitCode,
					timedOut: processOutcome.timedOut,
					aborted: processOutcome.aborted,
				};
			} else if (this.workspaceFS && action.kind.startsWith("fs_")) {
				const params = action.payload as Record<string, any>;
				if (action.kind === "fs_read") {
					const bytes = await this.workspaceFS.readFile(String(params.path));
					output = { content: Buffer.from(bytes).toString("utf8") };
				} else if (action.kind === "fs_write") {
					const contentBytes =
						typeof params.content === "string"
							? Buffer.from(params.content, "utf8")
							: (params.content as Uint8Array);
					await this.workspaceFS.writeFile(String(params.path), contentBytes);
					output = { written: true, path: params.path };
				} else if (action.kind === "fs_edit") {
					await this.workspaceFS.editFile(String(params.path), params.edits);
					output = { edited: true, path: params.path };
				} else if (action.kind === "fs_delete") {
					await this.workspaceFS.deleteFile(String(params.path));
					output = { deleted: true, path: params.path };
				}
			} else {
				const tool = this.tools.get(action.toolName);
				if (tool) {
					output = await tool.execute(context.toolCallId, action.payload, context.signal);
				} else {
					throw new Error(`Tool ${action.toolName} not registered in ExecutionBroker`);
				}
			}

			const successOutcome: ToolExecutionOutcome = {
				toolAttemptId: context.toolAttemptId,
				status: "completed",
				output,
				durationMs: Date.now() - start,
			};

			if (this.coordinator) {
				await this.coordinator.onAttemptSettled(context.toolAttemptId, successOutcome);
			}

			return successOutcome;
		} catch (err: unknown) {
			const failedOutcome: ToolExecutionOutcome = {
				toolAttemptId: context.toolAttemptId,
				status: "failed",
				error: err instanceof Error ? err.message : String(err),
				durationMs: Date.now() - start,
			};

			if (this.coordinator) {
				await this.coordinator.onAttemptSettled(context.toolAttemptId, failedOutcome);
			}

			return failedOutcome;
		}
	}
}
