import {
	asStepId,
	asToolAttemptId,
	asToolCallId,
	asTurnId,
	type ControllerEpoch,
	type ThreadId,
} from "@earendil-works/pi-protocol";
import { type Static, Type } from "typebox";
import type { AgentTool, AgentToolResult } from "../../types.ts";
import type { ExecutionBroker, ToolExecutionContext } from "../types/execution-broker.ts";

export interface BrokeredToolsOptions {
	readonly broker: ExecutionBroker;
	readonly threadId?: ThreadId;
	readonly controllerEpoch?: ControllerEpoch;
	readonly getContext?: () => Partial<ToolExecutionContext>;
}

// 1. Schemas
export const ReadToolSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});
export type BrokeredReadToolInput = Static<typeof ReadToolSchema>;

export const WriteToolSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});
export type BrokeredWriteToolInput = Static<typeof WriteToolSchema>;

export const EditToolSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit" }),
	edits: Type.Array(
		Type.Object({
			oldText: Type.String({ description: "Exact text to replace" }),
			newText: Type.String({ description: "Replacement text" }),
		}),
		{ description: "Sequential edits to apply" },
	),
});
export type BrokeredEditToolInput = Static<typeof EditToolSchema>;

export const BashToolSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});
export type BrokeredBashToolInput = Static<typeof BashToolSchema>;

let attemptCounter = 1;

function makeContext(options: BrokeredToolsOptions, toolCallId: string, signal?: AbortSignal): ToolExecutionContext {
	const custom = options.getContext?.();
	const now = Date.now();
	const attemptId = custom?.toolAttemptId ?? asToolAttemptId(`att_${now}_${attemptCounter++}`);
	const callId = custom?.toolCallId ?? asToolCallId(toolCallId);
	const turnId = custom?.turnId ?? asTurnId(`turn_${now}`);
	const stepId = custom?.stepId ?? asStepId(`step_${now}`);

	return {
		toolAttemptId: attemptId,
		toolCallId: callId,
		turnId,
		stepId,
		signal: signal ?? new AbortController().signal,
		threadId: custom?.threadId ?? options.threadId,
		controllerEpoch: custom?.controllerEpoch ?? options.controllerEpoch,
	};
}

async function executeViaBroker(
	toolName: string,
	params: unknown,
	options: BrokeredToolsOptions,
	toolCallId: string,
	signal?: AbortSignal,
): Promise<unknown> {
	const context = makeContext(options, toolCallId, signal);
	const prepared = await options.broker.prepareAction(toolName, params, context);
	const outcome = await options.broker.executeAction(prepared, context);

	if (outcome.status === "denied") {
		throw new Error(`Tool execution denied for ${toolName}: ${outcome.error ?? "Rejected by policy or approval"}`);
	}

	if (outcome.status === "failed") {
		throw new Error(`Tool execution failed for ${toolName}: ${outcome.error ?? "Execution error"}`);
	}

	return outcome.output;
}

function formatToolResult<T>(text: string, details: T): AgentToolResult<T> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

function unwrapDetails<T>(output: unknown): T {
	if (output && typeof output === "object" && "details" in output) {
		return (output as { details: T }).details;
	}
	return output as T;
}

export function createBrokeredReadTool(options: BrokeredToolsOptions): AgentTool<typeof ReadToolSchema> {
	return {
		name: "read",
		label: "read",
		description: "Read file contents within the allowed workspace roots via ExecutionBroker",
		parameters: ReadToolSchema,
		execute: async (toolCallId, params, signal) => {
			const raw = await executeViaBroker("read", params, options, toolCallId, signal);
			const details = unwrapDetails<{ content?: string }>(raw);
			const text =
				typeof details?.content === "string"
					? details.content
					: raw && typeof raw === "object" && "content" in raw && Array.isArray((raw as any).content)
						? ((raw as any).content[0]?.text ?? "")
						: "";
			return formatToolResult(text, details);
		},
	};
}

export function createBrokeredWriteTool(options: BrokeredToolsOptions): AgentTool<typeof WriteToolSchema> {
	return {
		name: "write",
		label: "write",
		description: "Create or overwrite files within the allowed workspace roots via ExecutionBroker",
		parameters: WriteToolSchema,
		execute: async (toolCallId, params, signal) => {
			const raw = await executeViaBroker("write", params, options, toolCallId, signal);
			const details = unwrapDetails<{ written?: boolean; path?: string }>(raw);
			return formatToolResult(`File written to ${params.path}`, details);
		},
	};
}

export function createBrokeredEditTool(options: BrokeredToolsOptions): AgentTool<typeof EditToolSchema> {
	return {
		name: "edit",
		label: "edit",
		description: "Apply atomic sequential edits to a file within allowed workspace roots via ExecutionBroker",
		parameters: EditToolSchema,
		execute: async (toolCallId, params, signal) => {
			const raw = await executeViaBroker("edit", params, options, toolCallId, signal);
			const details = unwrapDetails<{ edited?: boolean; path?: string }>(raw);
			return formatToolResult(`File edited at ${params.path}`, details);
		},
	};
}

export function createBrokeredBashTool(options: BrokeredToolsOptions): AgentTool<typeof BashToolSchema> {
	return {
		name: "bash",
		label: "bash",
		description: "Execute a shell command with security policies, approvals, and sandboxing via ExecutionBroker",
		parameters: BashToolSchema,
		execute: async (toolCallId, params, signal) => {
			const raw = await executeViaBroker("bash", params, options, toolCallId, signal);
			const details = unwrapDetails<{
				stdout?: string;
				stderr?: string;
				exitCode?: number;
			}>(raw);
			const text =
				details?.stdout ||
				details?.stderr ||
				(raw && typeof raw === "object" && "content" in raw && Array.isArray((raw as any).content)
					? ((raw as any).content[0]?.text ?? "")
					: "(empty output)");
			return formatToolResult(text, details);
		},
	};
}

export interface BrokeredCodingToolsSuite {
	readonly read: AgentTool<typeof ReadToolSchema>;
	readonly write: AgentTool<typeof WriteToolSchema>;
	readonly edit: AgentTool<typeof EditToolSchema>;
	readonly bash: AgentTool<typeof BashToolSchema>;
	readonly asArray: () => readonly AgentTool[];
	readonly asMap: () => ReadonlyMap<string, AgentTool>;
}

export function createBrokeredCodingTools(options: BrokeredToolsOptions): BrokeredCodingToolsSuite {
	const read = createBrokeredReadTool(options);
	const write = createBrokeredWriteTool(options);
	const edit = createBrokeredEditTool(options);
	const bash = createBrokeredBashTool(options);

	const map = new Map<string, AgentTool>([
		[read.name, read],
		[write.name, write],
		[edit.name, edit],
		[bash.name, bash],
	]);

	return {
		read,
		write,
		edit,
		bash,
		asArray: () => [read, write, edit, bash],
		asMap: () => map,
	};
}
