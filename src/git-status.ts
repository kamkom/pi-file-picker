import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

export type GitState = "conflicted" | "deleted" | "modified" | "renamed" | "added" | "untracked";

/** Higher wins when a folder aggregates the states of everything inside it. */
const PRIORITY: Record<GitState, number> = {
	untracked: 1,
	added: 2,
	renamed: 3,
	modified: 4,
	deleted: 5,
	conflicted: 6,
};

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export type Exec = (
	command: string,
	args: string[],
	options: { cwd: string; timeout: number },
) => Promise<{ code: number; stdout: string }>;

export function parseStatusCode(code: string): GitState | undefined {
	if (code === "??") return "untracked";
	if (CONFLICT_CODES.has(code)) return "conflicted";
	const [index, worktree] = code;
	if (index === "R" || worktree === "R") return "renamed";
	if (index === "D" || worktree === "D") return "deleted";
	if (index === "M" || worktree === "M" || index === "T" || worktree === "T") return "modified";
	if (index === "A" || index === "C") return "added";
	return undefined;
}

interface Snapshot {
	/** Path of the cwd relative to the repository root, "" at the root. */
	cwdInRepo: string;
	root: string;
	files: Map<string, GitState>;
	folders: Map<string, GitState>;
	/** Untracked folders reported as a whole (`?? dir/`); everything inside is untracked too. */
	untrackedFolders: string[];
}

/**
 * Cached `git status` for the picker. Lookups never block: they read the last snapshot and
 * schedule a refresh when it is stale.
 */
export class GitStatusCache {
	private readonly exec: Exec;
	private readonly cwd: string;
	private readonly ttlMs: number;
	private snapshot: Snapshot | null | undefined;
	private loadedAt = 0;
	private inflight: Promise<void> | undefined;
	private disposed = false;
	onUpdate?: () => void;

	constructor(exec: Exec, cwd: string, ttlMs = 2_000) {
		this.exec = exec;
		this.cwd = cwd;
		this.ttlMs = ttlMs;
	}

	/** State of an entry addressed the way the picker inserts it: relative to cwd, `~/...` or absolute. */
	get(path: string, isDirectory: boolean): GitState | undefined {
		this.refreshIfStale();
		const snapshot = this.snapshot;
		if (!snapshot) return undefined;
		const key = this.toRepoPath(snapshot, path);
		if (key === undefined) return undefined;
		const direct = isDirectory ? snapshot.folders.get(key) : snapshot.files.get(key);
		if (direct) return direct;
		for (const folder of snapshot.untrackedFolders) {
			if (key === folder || key.startsWith(`${folder}/`)) return "untracked";
		}
		return undefined;
	}

	/** Resolve once the first snapshot exists, or after `waitMs`, whichever comes first. */
	async warm(waitMs: number): Promise<void> {
		this.refreshIfStale();
		if (this.snapshot !== undefined || !this.inflight) return;
		await Promise.race([this.inflight, new Promise((resolve) => setTimeout(resolve, waitMs).unref?.())]);
	}

	markStale(): void {
		this.loadedAt = 0;
	}

	dispose(): void {
		this.disposed = true;
		this.onUpdate = undefined;
	}

	private refreshIfStale(): void {
		if (this.disposed || this.inflight || Date.now() - this.loadedAt < this.ttlMs) return;
		this.inflight = this.load()
			.then((snapshot) => {
				if (this.disposed) return;
				const changed = !sameSnapshot(this.snapshot, snapshot);
				this.snapshot = snapshot;
				this.loadedAt = Date.now();
				if (changed) this.onUpdate?.();
			})
			.catch(() => {
				this.snapshot = null;
				this.loadedAt = Date.now();
			})
			.finally(() => {
				this.inflight = undefined;
			});
	}

	private async load(): Promise<Snapshot | null> {
		const top = await this.exec("git", ["rev-parse", "--show-toplevel"], { cwd: this.cwd, timeout: 2_000 });
		if (top.code !== 0) return null;
		const root = top.stdout.trim();
		const status = await this.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], {
			cwd: this.cwd,
			timeout: 4_000,
		});
		if (status.code !== 0) return null;

		let realCwd = this.cwd;
		try {
			realCwd = realpathSync(this.cwd);
		} catch {}
		const cwdInRepo = toPosix(relative(root, realCwd));
		const snapshot: Snapshot = { cwdInRepo, root, files: new Map(), folders: new Map(), untrackedFolders: [] };

		const fields = status.stdout.split("\0");
		for (let i = 0; i < fields.length; i++) {
			const field = fields[i]!;
			if (field.length < 4) continue;
			const code = field.slice(0, 2);
			const path = field.slice(3);
			// Renames and copies are followed by the original path.
			if (code[0] === "R" || code[0] === "C") i++;
			const state = parseStatusCode(code);
			if (!state) continue;
			if (path.endsWith("/")) {
				const folder = path.slice(0, -1);
				snapshot.untrackedFolders.push(folder);
				bump(snapshot.folders, folder, state);
				bumpParents(snapshot.folders, folder, state);
			} else {
				snapshot.files.set(path, state);
				bumpParents(snapshot.folders, path, state);
			}
		}
		return snapshot;
	}

	private toRepoPath(snapshot: Snapshot, path: string): string | undefined {
		let absolute: string;
		if (path === "~" || path.startsWith("~/")) {
			absolute = join(homedir(), path.slice(1));
		} else if (isAbsolute(path)) {
			absolute = path;
		} else {
			const key = toPosix(normalize(join(snapshot.cwdInRepo, path)));
			return key.startsWith("..") ? undefined : key.replace(/\/$/, "");
		}
		const key = toPosix(relative(snapshot.root, absolute));
		return key.startsWith("..") || isAbsolute(key) ? undefined : key;
	}
}

function bump(folders: Map<string, GitState>, folder: string, state: GitState): void {
	const current = folders.get(folder);
	if (!current || PRIORITY[state] > PRIORITY[current]) folders.set(folder, state);
}

function bumpParents(folders: Map<string, GitState>, path: string, state: GitState): void {
	let slash = path.lastIndexOf("/");
	while (slash > 0) {
		path = path.slice(0, slash);
		bump(folders, path, state);
		slash = path.lastIndexOf("/");
	}
}

function toPosix(path: string): string {
	return sep === "/" ? path : path.split(sep).join("/");
}

function sameSnapshot(a: Snapshot | null | undefined, b: Snapshot | null): boolean {
	if (!a || !b) return a === b;
	if (a.files.size !== b.files.size || a.untrackedFolders.length !== b.untrackedFolders.length) return false;
	for (const [path, state] of a.files) if (b.files.get(path) !== state) return false;
	return a.untrackedFolders.every((folder, index) => b.untrackedFolders[index] === folder);
}
