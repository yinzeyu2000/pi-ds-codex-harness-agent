import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkspaceFSProvider } from "../types/providers.ts";
import { canonicalizePath, validatePathWithinRoots } from "./sandbox-provider.ts";

export interface LocalWorkspaceFSOptions {
	readonly deniedPaths?: readonly string[];
}

export class LocalWorkspaceFSProvider implements WorkspaceFSProvider {
	readonly workspaceRoots: readonly string[];
	readonly options?: LocalWorkspaceFSOptions;

	constructor(workspaceRoots: readonly string[], options?: LocalWorkspaceFSOptions) {
		this.workspaceRoots = workspaceRoots;
		this.options = options;
	}

	private resolveAndValidate(targetPath: string): string {
		const validation = validatePathWithinRoots(targetPath, this.workspaceRoots, this.options?.deniedPaths);
		if (!validation.ok) {
			throw new Error(`WorkspaceFS access denied for path '${targetPath}': ${validation.error}`);
		}
		return validation.canonicalPath;
	}

	async readFile(path: string): Promise<Uint8Array> {
		const resolved = this.resolveAndValidate(path);
		const buffer = await readFile(resolved);
		return new Uint8Array(buffer);
	}

	async writeFile(path: string, content: Uint8Array): Promise<void> {
		const resolved = this.resolveAndValidate(path);
		const dir = dirname(resolved);
		await mkdir(dir, { recursive: true });
		await writeFile(resolved, content);
	}

	async editFile(path: string, edits: readonly { oldText: string; newText: string }[]): Promise<void> {
		const resolved = this.resolveAndValidate(path);
		const existingBytes = await readFile(resolved);
		let text = Buffer.from(existingBytes).toString("utf8");

		for (const edit of edits) {
			if (!text.includes(edit.oldText)) {
				throw new Error(`WorkspaceFS edit failed: Target text not found in '${path}'`);
			}
			text = text.replace(edit.oldText, edit.newText);
		}

		await writeFile(resolved, Buffer.from(text, "utf8"));
	}

	async deleteFile(path: string): Promise<void> {
		const resolved = this.resolveAndValidate(path);
		await rm(resolved, { force: true, recursive: true });
	}

	async renameFile(fromPath: string, toPath: string): Promise<void> {
		const resolvedFrom = this.resolveAndValidate(fromPath);
		const resolvedTo = this.resolveAndValidate(toPath);
		const toDir = dirname(resolvedTo);
		await mkdir(toDir, { recursive: true });
		await rename(resolvedFrom, resolvedTo);
	}

	async exists(path: string): Promise<boolean> {
		try {
			const resolved = this.resolveAndValidate(path);
			await access(resolved, constants.F_OK);
			return true;
		} catch {
			return false;
		}
	}
}

export class MemoryWorkspaceFSProvider implements WorkspaceFSProvider {
	private readonly files = new Map<string, Uint8Array>();
	readonly workspaceRoots?: readonly string[];
	readonly options?: LocalWorkspaceFSOptions;

	constructor(
		initialFiles?: Record<string, Uint8Array | string>,
		workspaceRoots?: readonly string[],
		options?: LocalWorkspaceFSOptions,
	) {
		this.workspaceRoots = workspaceRoots;
		this.options = options;

		if (initialFiles) {
			for (const [filePath, content] of Object.entries(initialFiles)) {
				const canonical = canonicalizePath(filePath);
				if (typeof content === "string") {
					this.files.set(canonical, new TextEncoder().encode(content));
				} else {
					this.files.set(canonical, content);
				}
			}
		}
	}

	private resolveAndValidate(targetPath: string): string {
		if (this.workspaceRoots && this.workspaceRoots.length > 0) {
			const validation = validatePathWithinRoots(targetPath, this.workspaceRoots, this.options?.deniedPaths);
			if (!validation.ok) {
				throw new Error(`MemoryWorkspaceFS access denied for path '${targetPath}': ${validation.error}`);
			}
			return validation.canonicalPath;
		}
		return canonicalizePath(targetPath);
	}

	async readFile(path: string): Promise<Uint8Array> {
		const resolved = this.resolveAndValidate(path);
		const content = this.files.get(resolved);
		if (!content) {
			throw new Error(`File not found: ${path}`);
		}
		return new Uint8Array(content);
	}

	async writeFile(path: string, content: Uint8Array): Promise<void> {
		const resolved = this.resolveAndValidate(path);
		this.files.set(resolved, new Uint8Array(content));
	}

	async editFile(path: string, edits: readonly { oldText: string; newText: string }[]): Promise<void> {
		const resolved = this.resolveAndValidate(path);
		const content = this.files.get(resolved);
		if (!content) {
			throw new Error(`File not found for edit: ${path}`);
		}

		let text = new TextDecoder().decode(content);
		for (const edit of edits) {
			if (!text.includes(edit.oldText)) {
				throw new Error(`MemoryWorkspaceFS edit failed: Target text not found in '${path}'`);
			}
			text = text.replace(edit.oldText, edit.newText);
		}

		this.files.set(resolved, new TextEncoder().encode(text));
	}

	async deleteFile(path: string): Promise<void> {
		const resolved = this.resolveAndValidate(path);
		this.files.delete(resolved);
	}

	async renameFile(fromPath: string, toPath: string): Promise<void> {
		const resolvedFrom = this.resolveAndValidate(fromPath);
		const resolvedTo = this.resolveAndValidate(toPath);
		const content = this.files.get(resolvedFrom);
		if (!content) {
			throw new Error(`File not found for rename: ${fromPath}`);
		}
		this.files.delete(resolvedFrom);
		this.files.set(resolvedTo, content);
	}

	async exists(path: string): Promise<boolean> {
		try {
			const resolved = this.resolveAndValidate(path);
			return this.files.has(resolved);
		} catch {
			return false;
		}
	}
}
