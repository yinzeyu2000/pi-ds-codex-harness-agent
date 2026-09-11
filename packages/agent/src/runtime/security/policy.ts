import type {
	CommandPermission,
	ExecutionEnvironment,
	FilesystemPermission,
	IpcPermission,
	NetworkPermission,
	PermissionProfile,
	PolicyDecision,
	PolicyEngine,
	PolicyEvaluationContext,
	ResourceLimits,
	SandboxMode,
} from "./types.ts";

export function normalizePathSeparators(p: string): string {
	let normalized = p.replaceAll("\\", "/");
	// Remove trailing slash unless root
	if (normalized.length > 1 && normalized.endsWith("/")) {
		normalized = normalized.slice(0, -1);
	}
	return normalized;
}

export function isSubpathOrEqual(child: string, parent: string): boolean {
	const normChild = normalizePathSeparators(child).toLowerCase();
	const normParent = normalizePathSeparators(parent).toLowerCase();

	if (normChild === normParent) return true;
	return normChild.startsWith(normParent.endsWith("/") ? normParent : `${normParent}/`);
}

export function matchesPattern(text: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (!pattern.includes("*")) {
		return text.toLowerCase() === pattern.toLowerCase();
	}

	const escapeRegex = (s: string) => s.replace(/[-[\]{}()+?.,\\^$|#\s]/g, "\\$&");
	const regexStr = `^${pattern.split("*").map(escapeRegex).join(".*")}$`;
	const regex = new RegExp(regexStr, "i");
	return regex.test(text);
}

export function intersectPermissionProfiles(
	p1: PermissionProfile,
	p2: PermissionProfile,
	newProfileId?: string,
): PermissionProfile {
	// Commands: Deny wins (union of deny); Allow intersects
	let mergedCommands: CommandPermission | undefined;
	if (p1.commands || p2.commands) {
		const c1 = p1.commands;
		const c2 = p2.commands;

		const deny = Array.from(new Set([...(c1?.deny ?? []), ...(c2?.deny ?? [])]));

		let allow: string[];
		if (c1?.allow && c2?.allow) {
			allow = c1.allow.filter((cmd1) => c2.allow.some((cmd2) => cmd1 === cmd2));
		} else if (c1?.allow) {
			allow = [...c1.allow];
		} else if (c2?.allow) {
			allow = [...c2.allow];
		} else {
			allow = [];
		}

		mergedCommands = { allow, deny: deny.length > 0 ? deny : undefined };
	}

	// Filesystem: Deny paths union; roots narrow down
	let mergedFilesystem: FilesystemPermission | undefined;
	if (p1.filesystem || p2.filesystem) {
		const fs1 = p1.filesystem;
		const fs2 = p2.filesystem;

		const deniedPaths = Array.from(new Set([...(fs1?.deniedPaths ?? []), ...(fs2?.deniedPaths ?? [])]));

		const intersectRoots = (roots1: readonly string[], roots2: readonly string[]): string[] => {
			const result: string[] = [];
			for (const r1 of roots1) {
				for (const r2 of roots2) {
					if (isSubpathOrEqual(r1, r2)) {
						result.push(r1);
					} else if (isSubpathOrEqual(r2, r1)) {
						result.push(r2);
					}
				}
			}
			return Array.from(new Set(result));
		};

		const readRoots =
			fs1?.readRoots && fs2?.readRoots
				? intersectRoots(fs1.readRoots, fs2.readRoots)
				: [...(fs1?.readRoots ?? fs2?.readRoots ?? [])];

		const writeRoots =
			fs1?.writeRoots && fs2?.writeRoots
				? intersectRoots(fs1.writeRoots, fs2.writeRoots)
				: [...(fs1?.writeRoots ?? fs2?.writeRoots ?? [])];

		mergedFilesystem = {
			readRoots,
			writeRoots,
			deniedPaths: deniedPaths.length > 0 ? deniedPaths : undefined,
		};
	}

	// Network: allowNetwork requires both to be true; allowedHosts intersects
	let mergedNetwork: NetworkPermission | undefined;
	if (p1.network || p2.network) {
		const n1 = p1.network;
		const n2 = p2.network;

		const allowNetwork = (n1?.allowNetwork ?? false) && (n2?.allowNetwork ?? false);

		let allowedHosts: string[] | undefined;
		if (n1?.allowedHosts && n2?.allowedHosts) {
			allowedHosts = n1.allowedHosts.filter((h1) => n2.allowedHosts!.includes(h1));
		} else if (n1?.allowedHosts) {
			allowedHosts = [...n1.allowedHosts];
		} else if (n2?.allowedHosts) {
			allowedHosts = [...n2.allowedHosts];
		}

		mergedNetwork = {
			allowNetwork,
			allowedHosts,
			allowUnixSockets: (n1?.allowUnixSockets ?? false) && (n2?.allowUnixSockets ?? false),
			allowNamedPipes: (n1?.allowNamedPipes ?? false) && (n2?.allowNamedPipes ?? false),
		};
	}

	// IPC: allowIpc requires both to be true; channels intersect
	let mergedIpc: IpcPermission | undefined;
	if (p1.ipc || p2.ipc) {
		const ipc1 = p1.ipc;
		const ipc2 = p2.ipc;

		const allowIpc = (ipc1?.allowIpc ?? false) && (ipc2?.allowIpc ?? false);
		let allowedChannels: string[] | undefined;
		if (ipc1?.allowedChannels && ipc2?.allowedChannels) {
			allowedChannels = ipc1.allowedChannels.filter((c1) => ipc2.allowedChannels!.includes(c1));
		}

		mergedIpc = {
			allowIpc,
			allowedChannels,
		};
	}

	return {
		profileId: newProfileId ?? `${p1.profileId}∩${p2.profileId}`,
		commands: mergedCommands,
		filesystem: mergedFilesystem,
		network: mergedNetwork,
		ipc: mergedIpc,
	};
}

export function intersectResourceLimits(r1: ResourceLimits, r2: ResourceLimits): ResourceLimits {
	const minDefined = (a?: number, b?: number): number | undefined => {
		if (a === undefined) return b;
		if (b === undefined) return a;
		return Math.min(a, b);
	};

	return {
		timeoutMs: minDefined(r1.timeoutMs, r2.timeoutMs),
		maxMemoryBytes: minDefined(r1.maxMemoryBytes, r2.maxMemoryBytes),
		maxProcesses: minDefined(r1.maxProcesses, r2.maxProcesses),
		maxOutputBytes: minDefined(r1.maxOutputBytes, r2.maxOutputBytes),
		maxDiskSpillBytes: minDefined(r1.maxDiskSpillBytes, r2.maxDiskSpillBytes),
	};
}

export function freezeExecutionEnvironment(
	base: ExecutionEnvironment,
	overrides?: Partial<ExecutionEnvironment>,
): ExecutionEnvironment {
	if (!overrides) return base;

	// Plugins cannot downgrade sandbox security mode
	let sandboxMode: SandboxMode = base.sandboxMode;
	if (overrides.sandboxMode) {
		if (base.sandboxMode === "secure" && overrides.sandboxMode !== "secure") {
			throw new Error("Cannot downgrade sandboxMode from 'secure' to a less secure mode");
		}
		if (base.sandboxMode === "read-only" && overrides.sandboxMode === "trusted-local") {
			throw new Error("Cannot downgrade sandboxMode from 'read-only' to 'trusted-local'");
		}
		sandboxMode = overrides.sandboxMode;
	}

	// Environment variable allowlist can only be narrowed, not widened
	let envAllowlist = base.envAllowlist;
	if (overrides.envAllowlist) {
		if (base.envAllowlist) {
			envAllowlist = overrides.envAllowlist.filter((k) => base.envAllowlist!.includes(k));
		} else {
			envAllowlist = [...overrides.envAllowlist];
		}
	}

	return {
		program: overrides.program ?? base.program,
		args: overrides.args ? [...overrides.args] : base.args,
		cwd: overrides.cwd ?? base.cwd,
		envAllowlist,
		tty: overrides.tty !== undefined ? overrides.tty && (base.tty ?? false) : base.tty,
		sandboxMode,
	};
}

export class DefaultPolicyEngine implements PolicyEngine {
	private readonly defaultRequireApprovalTools = new Set(["bash", "shell", "exec"]);

	constructor(customRequireApprovalTools?: readonly string[]) {
		if (customRequireApprovalTools) {
			for (const t of customRequireApprovalTools) {
				this.defaultRequireApprovalTools.add(t);
			}
		}
	}

	async evaluate(context: PolicyEvaluationContext): Promise<PolicyDecision> {
		const { action, profile } = context;

		// 1. Check explicit approval request in action
		if (action.requiresApproval) {
			return {
				decision: "requires_approval",
				reason: "Action explicitly marked as requiring approval",
				promptMessage: `Tool ${action.toolName} requests user approval before execution`,
			};
		}

		// 2. Default approval requirement for privileged shell/process tools
		if (this.defaultRequireApprovalTools.has(action.toolName)) {
			return {
				decision: "requires_approval",
				reason: `Privileged tool ${action.toolName} requires user approval`,
				promptMessage: `Allow execution of ${action.toolName}?`,
			};
		}

		if (!profile) {
			// No profile restrictions: allowed
			return { decision: "allow" };
		}

		// 3. Process/Command evaluation
		if (action.kind === "process" && profile.commands) {
			const payload = action.payload as { command?: string; cmd?: string };
			const commandStr = payload?.command ?? payload?.cmd ?? action.toolName;

			if (profile.commands.deny) {
				for (const denyPattern of profile.commands.deny) {
					if (matchesPattern(commandStr, denyPattern)) {
						return {
							decision: "deny",
							reason: `Command '${commandStr}' matches denied pattern '${denyPattern}'`,
						};
					}
				}
			}

			if (profile.commands.allow && profile.commands.allow.length > 0) {
				const isAllowed = profile.commands.allow.some((allowPattern) => matchesPattern(commandStr, allowPattern));
				if (!isAllowed) {
					return {
						decision: "deny",
						reason: `Command '${commandStr}' is not in allowed command list`,
					};
				}
			}
		}

		// 4. Filesystem path evaluation
		if (
			(action.kind === "fs_read" ||
				action.kind === "fs_write" ||
				action.kind === "fs_edit" ||
				action.kind === "fs_delete") &&
			profile.filesystem
		) {
			const paths = action.paths ?? [];

			// Check denied paths
			if (profile.filesystem.deniedPaths) {
				for (const targetPath of paths) {
					for (const denied of profile.filesystem.deniedPaths) {
						if (isSubpathOrEqual(targetPath, denied)) {
							return {
								decision: "deny",
								reason: `Path '${targetPath}' is in denied paths list ('${denied}')`,
							};
						}
					}
				}
			}

			// Check allowed read / write roots
			if (action.kind === "fs_read" && profile.filesystem.readRoots.length > 0) {
				for (const targetPath of paths) {
					const inRoot = profile.filesystem.readRoots.some((root) => isSubpathOrEqual(targetPath, root));
					if (!inRoot) {
						return {
							decision: "deny",
							reason: `Read path '${targetPath}' is outside allowed read roots`,
						};
					}
				}
			}

			if (
				(action.kind === "fs_write" || action.kind === "fs_edit" || action.kind === "fs_delete") &&
				profile.filesystem.writeRoots.length > 0
			) {
				for (const targetPath of paths) {
					const inRoot = profile.filesystem.writeRoots.some((root) => isSubpathOrEqual(targetPath, root));
					if (!inRoot) {
						return {
							decision: "deny",
							reason: `Write path '${targetPath}' is outside allowed write roots`,
						};
					}
				}
			}
		}

		// 5. Network evaluation
		if (action.kind === "network" && profile.network) {
			if (!profile.network.allowNetwork) {
				return {
					decision: "deny",
					reason: "Network access is denied by policy profile",
				};
			}

			if (profile.network.allowedHosts && action.networkHosts) {
				for (const host of action.networkHosts) {
					if (!profile.network.allowedHosts.includes(host)) {
						return {
							decision: "deny",
							reason: `Host '${host}' is not in allowed network hosts list`,
						};
					}
				}
			}
		}

		return { decision: "allow" };
	}
}
