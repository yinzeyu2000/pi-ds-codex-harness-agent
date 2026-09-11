import type { PreparedAction, ToolExecutionContext } from "../types/execution-broker.ts";

export interface CommandPermission {
	readonly allow: readonly string[];
	readonly deny?: readonly string[];
}

export interface FilesystemPermission {
	readonly readRoots: readonly string[];
	readonly writeRoots: readonly string[];
	readonly deniedPaths?: readonly string[];
}

export interface NetworkPermission {
	readonly allowNetwork: boolean;
	readonly allowedHosts?: readonly string[];
	readonly allowUnixSockets?: boolean;
	readonly allowNamedPipes?: boolean;
}

export interface IpcPermission {
	readonly allowIpc: boolean;
	readonly allowedChannels?: readonly string[];
}

export interface PermissionProfile {
	readonly profileId: string;
	readonly commands?: CommandPermission;
	readonly filesystem?: FilesystemPermission;
	readonly network?: NetworkPermission;
	readonly ipc?: IpcPermission;
}

export interface ResourceLimits {
	readonly timeoutMs?: number;
	readonly maxMemoryBytes?: number;
	readonly maxProcesses?: number;
	readonly maxOutputBytes?: number;
	readonly maxDiskSpillBytes?: number;
}

export type SandboxMode = "secure" | "trusted-local" | "read-only";

export interface ExecutionEnvironment {
	readonly program: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly envAllowlist?: readonly string[];
	readonly tty?: boolean;
	readonly sandboxMode: SandboxMode;
}

export type PolicyDecision =
	| { readonly decision: "allow" }
	| { readonly decision: "deny"; readonly reason: string }
	| { readonly decision: "requires_approval"; readonly reason: string; readonly promptMessage?: string };

export interface PolicyEvaluationContext {
	readonly action: PreparedAction;
	readonly executionContext: ToolExecutionContext;
	readonly profile?: PermissionProfile;
	readonly limits?: ResourceLimits;
	readonly environment?: ExecutionEnvironment;
}

export interface PolicyEngine {
	evaluate(context: PolicyEvaluationContext): Promise<PolicyDecision>;
}

export interface ApprovalFingerprintInput {
	readonly threadId: string;
	readonly turnId: string;
	readonly toolAttemptId: string;
	readonly toolName: string;
	readonly command?: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly readRoots?: readonly string[];
	readonly writeRoots?: readonly string[];
	readonly network?: NetworkPermission;
	readonly sandboxMode?: string;
	readonly controllerEpoch?: number;
}
