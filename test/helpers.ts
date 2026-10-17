import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	getEditorTheme,
	initTheme,
	theme,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import type { GitStatusCache } from "../src/git-status.ts";
import { type EntryMeta, PICKER_META, type PickerEnvironment, type PickerItem } from "../src/picker-list.ts";
import { DEFAULT_SETTINGS, type PickerSettings } from "../src/settings.ts";

initTheme("dark", false);

export { getEditorTheme, theme };

export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_[^\x07]*\x07/g, "");
}

/** A throwaway project: `{ "src/a.ts": "content", "docs/": "" }` (trailing slash = folder). */
export function makeProject(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "pi-file-picker-"));
	for (const [path, content] of Object.entries(files)) {
		const target = join(root, path);
		if (path.endsWith("/")) {
			mkdirSync(target, { recursive: true });
		} else {
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content);
		}
	}
	return root;
}

export function item(path: string, options: { query?: string; directory?: boolean } = {}): PickerItem {
	const isDirectory = options.directory ?? false;
	const slash = path.lastIndexOf("/");
	const meta: EntryMeta = {
		path,
		name: slash === -1 ? path : path.slice(slash + 1),
		parent: slash === -1 ? "" : path.slice(0, slash),
		isDirectory,
		query: options.query ?? "",
		prefix: `@${options.query ?? ""}`,
	};
	return {
		value: `@${path}${isDirectory ? "/" : ""}`,
		label: `${meta.name}${isDirectory ? "/" : ""}`,
		description: path,
		[PICKER_META]: meta,
	};
}

export function environment(
	overrides: Partial<PickerSettings> = {},
	options: { cwd?: string; git?: GitStatusCache } = {},
): PickerEnvironment {
	const settings = { ...DEFAULT_SETTINGS, ...overrides };
	return {
		theme,
		settings,
		git: options.git,
		resolve: (path) => join(options.cwd ?? "/nonexistent", path),
	};
}
