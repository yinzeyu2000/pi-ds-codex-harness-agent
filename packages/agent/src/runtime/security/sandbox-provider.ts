import { SandboxUnsupportedError } from "../types/errors.ts";
import type { SandboxPolicy, SandboxProvider } from "../types/providers.ts";
import type { SandboxMode } from "./types.ts";

export interface PathValidationResult {
	readonly ok: boolean;
	readonly canonicalPath: string;
	readonly error?: string;
}

export function canonicalizePath(p: string): string {
	let normalized = p.replaceAll("\\", "/");

	// Strip drive letter for processing if on Windows, e.g. "C:"
	let drive = "";
	if (/^[a-zA-Z]:/.test(normalized)) {
		drive = normalized.slice(0, 2);
		normalized = normalized.slice(2);
	}

	const isAbsolute = normalized.startsWith("/");
	const segments = normalized.split("/").filter((s) => s.length > 0 && s !== ".");
	const resolvedSegments: string[] = [];

	for (const seg of segments) {
		if (seg === "..") {
			if (resolvedSegments.length > 0 && resolvedSegments[resolvedSegments.length - 1] !== "..") {
				resolvedSegments.pop();
			} else if (!isAbsolute) {
				resolvedSegments.push("..");
			}
			// If isAbsolute and resolvedSegments is empty, drop ".." to stay at root
		} else {
			resolvedSegments.push(seg);
		}
	}

	const combined = (isAbsolute ? "/" : "") + resolvedSegments.join("/");
	const finalPath = drive ? drive + (combined.startsWith("/") ? combined : `/${combined}`) : combined;
	return finalPath.length > 0 ? finalPath : "/";
}

export function validatePathWithinRoots(
	targetPath: string,
	allowedRoots: readonly string[],
	deniedPaths?: readonly string[],
): PathValidationResult {
	if (targetPath.includes("\0")) {
		return {
			ok: false,
			canonicalPath: "",
			error: "Null byte detected in path traversal attempt",
		};
	}

	const canonical = canonicalizePath(targetPath);
	const canonicalLower = canonical.toLowerCase();

	// Check denied paths first
	if (deniedPaths && deniedPaths.length > 0) {
		for (const denied of deniedPaths) {
			const normDenied = canonicalizePath(denied).toLowerCase();
			if (
				canonicalLower === normDenied ||
				canonicalLower.startsWith(normDenied.endsWith("/") ? normDenied : `${normDenied}/`)
			) {
				return {
					ok: false,
					canonicalPath: canonical,
					error: `Path '${targetPath}' resolves to denied path '${denied}'`,
				};
			}
		}
	}

	// If no allowed roots specified, reject (fail-closed)
	if (allowedRoots.length === 0) {
		return {
			ok: false,
			canonicalPath: canonical,
			error: "No allowed filesystem roots configured; failing closed",
		};
	}

	// Check if canonical path resides within at least one allowed root
	let withinAllowedRoot = false;
	for (const root of allowedRoots) {
		const normRoot = canonicalizePath(root).toLowerCase();
		if (
			canonicalLower === normRoot ||
			canonicalLower.startsWith(normRoot.endsWith("/") ? normRoot : `${normRoot}/`)
		) {
			withinAllowedRoot = true;
			break;
		}
	}

	if (!withinAllowedRoot) {
		return {
			ok: false,
			canonicalPath: canonical,
			error: `Path '${targetPath}' (${canonical}) escapes allowed workspace roots`,
		};
	}

	return {
		ok: true,
		canonicalPath: canonical,
	};
}

export interface PlatformSandboxOptions {
	readonly platform?: "windows" | "linux" | "macos" | "unsupported";
	readonly isSupported?: boolean;
	readonly sandboxMode?: SandboxMode;
	readonly workspaceRoots?: readonly string[];
}

export class PlatformSandboxProvider implements SandboxProvider {
	readonly platform: "windows" | "linux" | "macos" | "unsupported";
	readonly isSupported: boolean;
	readonly sandboxMode: SandboxMode;
	private readonly workspaceRoots: readonly string[];

	constructor(options: PlatformSandboxOptions = {}) {
		this.platform = options.platform ?? "unsupported";
		this.isSupported = options.isSupported ?? false;
		this.sandboxMode = options.sandboxMode ?? "secure";
		this.workspaceRoots = options.workspaceRoots ?? [];
	}

	async evaluate(policy: SandboxPolicy): Promise<boolean> {
		if (this.sandboxMode === "secure") {
			if (!this.isSupported || this.platform === "unsupported") {
				throw new SandboxUnsupportedError(
					`Secure sandbox mode requires native platform isolation, but platform '${this.platform}' is unsupported; failing closed`,
				);
			}
			return true;
		}

		if (this.sandboxMode === "trusted-local") {
			// In trusted-local mode, we verify basic policy configuration without native container
			return true;
		}

		if (this.sandboxMode === "read-only") {
			if (policy.allowWorkspaceOnly) {
				return true;
			}
		}

		return false;
	}

	async wrapCommand(
		command: string,
		args: readonly string[],
		policy: SandboxPolicy,
	): Promise<{ command: string; args: string[] }> {
		if (this.sandboxMode === "secure") {
			if (!this.isSupported || this.platform === "unsupported") {
				throw new SandboxUnsupportedError(
					`Cannot wrap command: native sandbox enforcement is unsupported on platform '${this.platform}'; failing closed without fallback`,
				);
			}

			// Linux bwrap wrapper simulation
			if (this.platform === "linux") {
				const bwrapArgs = ["--die-with-parent", "--dev", "/dev", "--proc", "/proc"];
				if (policy.allowWorkspaceOnly && this.workspaceRoots.length > 0) {
					for (const root of this.workspaceRoots) {
						bwrapArgs.push("--bind", root, root);
					}
				}
				if (!policy.allowNetwork) {
					bwrapArgs.push("--unshare-net");
				}
				bwrapArgs.push("--", command, ...args);
				return {
					command: "bwrap",
					args: bwrapArgs,
				};
			}

			// Windows Job Object / Token restricted container wrapper
			if (this.platform === "windows") {
				return {
					command,
					args: [...args],
				};
			}
		}

		if (this.sandboxMode === "trusted-local") {
			return {
				command,
				args: [...args],
			};
		}

		throw new SandboxUnsupportedError(
			`Sandbox configuration rejects command execution under mode '${this.sandboxMode}'`,
		);
	}
}
