import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import type { ListFactory } from "./editor-hook.ts";
import { type Exec, GitStatusCache } from "./git-status.ts";
import { FilePickerList, isPickerItem, type PickerEnvironment } from "./picker-list.ts";
import { createFilePickerProvider } from "./provider.ts";
import type { PickerSettings } from "./settings.ts";

export interface PickerRuntimeOptions {
	cwd: string;
	exec: Exec;
	theme(): Theme;
	settings(): PickerSettings;
}

export interface PickerRuntime {
	readonly env: PickerEnvironment;
	readonly git: GitStatusCache;
	/** Editor hook factory: a picker list for file suggestions, undefined for everything else. */
	readonly createList: ListFactory;
	/** Autocomplete wrapper; `labelIcons` writes icons into labels for the stock list fallback. */
	wrapProvider(current: AutocompleteProvider, labelIcons: boolean): AutocompleteProvider;
	dispose(): void;
}

/** Everything one session needs, independent of the extension API so it can be driven in tests. */
export function createPickerRuntime(options: PickerRuntimeOptions): PickerRuntime {
	const { cwd } = options;
	const resolve = (path: string) => {
		if (path === "~" || path.startsWith("~/")) return join(homedir(), path.slice(1));
		return isAbsolute(path) ? path : join(cwd, path);
	};
	const git = new GitStatusCache(options.exec, cwd);
	const env: PickerEnvironment = {
		get theme() {
			return options.theme();
		},
		get settings() {
			return options.settings();
		},
		get git() {
			return options.settings().gitStatus ? git : undefined;
		},
		resolve,
	};

	const createList: ListFactory = (editor, _prefix, items) => {
		const settings = options.settings();
		if (!settings.enabled || items.length === 0 || !items.every(isPickerItem)) return undefined;
		// Late git results repaint the open list.
		const tui = (editor as unknown as { tui?: { requestRender(): void } }).tui;
		git.onUpdate = () => tui?.requestRender();
		return new FilePickerList(items, settings.maxVisible ?? editor.getAutocompleteMaxVisible(), env);
	};

	return {
		env,
		git,
		createList,
		wrapProvider: (current, labelIcons) =>
			createFilePickerProvider(current, {
				enabled: () => options.settings().enabled,
				resolve,
				labelIcons: () => (labelIcons ? options.settings().icons : undefined),
			}),
		dispose: () => git.dispose(),
	};
}
