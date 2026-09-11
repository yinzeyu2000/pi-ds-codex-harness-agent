import { asStepId, asToolAttemptId, asToolCallId, asTurnId } from "@earendil-works/pi-protocol";
import type { AgentTool, AgentToolResult } from "../../types.ts";
import type { ExecutionBroker, ToolExecutionContext } from "../types/execution-broker.ts";
import type { Plugin, PluginContext } from "./context.ts";
import type { PluginManifest } from "./manifest.ts";
import { TOOLS_SERVICE, type ToolCatalog } from "./services.ts";

export interface ExtensionPromptContributor {
	readonly name: string;
	getPromptContribution(context: unknown): string | Promise<string>;
}

export interface ExtensionCommand {
	readonly name: string;
	readonly description?: string;
	execute(args: readonly string[]): Promise<unknown>;
}

export interface PiExtensionContext {
	readonly signal?: AbortSignal;
	registerTool(tool: AgentTool): void;
	registerCommand(name: string, execute: (args: readonly string[]) => Promise<unknown>, description?: string): void;
	registerPromptContributor(contributor: ExtensionPromptContributor): void;
	on(event: string, listener: (...args: unknown[]) => void): void;
}

export type PiExtensionEntry = (context: PiExtensionContext) => void | Promise<void>;

export interface PiExtensionFacadeOptions {
	readonly name: string;
	readonly version?: string;
	readonly broker?: ExecutionBroker;
	readonly entry: PiExtensionEntry;
}

export class PiExtensionFacade implements Plugin {
	readonly manifest: PluginManifest;
	readonly options: PiExtensionFacadeOptions;
	private readonly registeredTools = new Map<string, AgentTool>();
	private readonly registeredCommands = new Map<string, ExtensionCommand>();
	private readonly registeredContributors = new Map<string, ExtensionPromptContributor>();

	constructor(options: PiExtensionFacadeOptions) {
		this.options = options;
		const sanitizedName = options.name.replace(/[^a-zA-Z0-9_-]/g, "_");
		this.manifest = {
			id: `pi_ext_${sanitizedName}`,
			version: options.version ?? "1.0.0",
			optional: [{ id: TOOLS_SERVICE.id }],
			provides: [{ id: `pi.extension.${sanitizedName}`, version: options.version ?? "1.0.0" }],
		};
	}

	get tools(): ReadonlyMap<string, AgentTool> {
		return this.registeredTools;
	}

	get commands(): ReadonlyMap<string, ExtensionCommand> {
		return this.registeredCommands;
	}

	get promptContributors(): ReadonlyMap<string, ExtensionPromptContributor> {
		return this.registeredContributors;
	}

	async activate(ctx: PluginContext): Promise<void> {
		const toolCatalog = ctx.get(TOOLS_SERVICE) as ToolCatalog | undefined;

		const extCtx: PiExtensionContext = {
			signal: ctx.signal,
			registerTool: (tool: AgentTool) => {
				const wrapped = this.options.broker ? this.wrapToolWithBroker(tool, this.options.broker) : tool;
				this.registeredTools.set(wrapped.name, wrapped);
				if (toolCatalog) {
					toolCatalog.registerTool(wrapped);
				}
			},
			registerCommand: (
				name: string,
				execute: (args: readonly string[]) => Promise<unknown>,
				description?: string,
			) => {
				this.registeredCommands.set(name, { name, execute, description });
			},
			registerPromptContributor: (contributor: ExtensionPromptContributor) => {
				this.registeredContributors.set(contributor.name, contributor);
			},
			on: (_event: string, _listener: (...args: unknown[]) => void) => {
				// Extension event hook registration
			},
		};

		await this.options.entry(extCtx);
	}

	private wrapToolWithBroker(tool: AgentTool, broker: ExecutionBroker): AgentTool {
		return {
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			execute: async (toolCallId, params, signal) => {
				const now = Date.now();
				const context: ToolExecutionContext = {
					toolAttemptId: asToolAttemptId(`att_${now}_${Math.random().toString(36).slice(2, 6)}`),
					toolCallId: asToolCallId(toolCallId),
					turnId: asTurnId(`turn_${now}`),
					stepId: asStepId(`step_${now}`),
					signal: signal ?? new AbortController().signal,
				};

				const prepared = await broker.prepareAction(tool.name, params, context);
				const outcome = await broker.executeAction(prepared, context);

				if (outcome.status === "denied") {
					throw new Error(`Execution denied for tool ${tool.name}: ${outcome.error ?? "Rejected"}`);
				}
				if (outcome.status === "failed") {
					throw new Error(`Execution failed for tool ${tool.name}: ${outcome.error ?? "Failure"}`);
				}

				if (outcome.output && typeof outcome.output === "object" && "content" in (outcome.output as any)) {
					return outcome.output as AgentToolResult<any>;
				}
				return {
					content: [
						{
							type: "text",
							text: typeof outcome.output === "string" ? outcome.output : JSON.stringify(outcome.output ?? ""),
						},
					],
					details: outcome.output,
				};
			},
		};
	}
}
