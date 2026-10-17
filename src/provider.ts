import { existsSync } from "node:fs";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { iconGlyph, type IconSet, resolveIcon } from "./icons.ts";
import { queryFromPrefix } from "./match.ts";
import { type EntryMeta, PICKER_META, type PickerItem } from "./picker-list.ts";

export interface ProviderOptions {
	enabled(): boolean;
	/** Absolute file-system path for a picker path. */
	resolve(path: string): string;
	/**
	 * When the editor hook is unavailable the stock list renders the items, so the icon is
	 * written into the label instead. Returns the icon set to use, or undefined to leave labels alone.
	 */
	labelIcons(): IconSet | undefined;
}

/** How many suggestions are checked against the file system before trusting a list as files. */
const EXISTENCE_SAMPLE = 3;

/** The path a completion value inserts: strips `@`, quotes and the trailing slash. */
export function pathFromValue(value: string): string {
	let path = value;
	if (path.startsWith("@")) path = path.slice(1);
	if (path.startsWith('"')) path = path.slice(1);
	if (path.endsWith('"')) path = path.slice(0, -1);
	if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
	return path;
}

/** File-system metadata for a suggestion, or undefined when it does not look like one. */
export function toEntryMeta(item: AutocompleteItem, prefix: string): EntryMeta | undefined {
	const isDirectory = item.label.endsWith("/");
	const name = isDirectory ? item.label.slice(0, -1) : item.label;
	const path = pathFromValue(item.value);
	if (!name || !path) return undefined;
	const slash = path.lastIndexOf("/");
	// Built-in file suggestions always label an entry with its own base name.
	if ((slash === -1 ? path : path.slice(slash + 1)) !== name) return undefined;
	const parent = slash === -1 ? "" : slash === 0 ? "/" : path.slice(0, slash);
	return { path, name, parent, isDirectory, query: queryFromPrefix(prefix), prefix };
}

/**
 * Wraps the current provider and tags file suggestions with metadata for the picker list.
 * Suggestions, completion and triggers stay the built-in ones, so `@` search, quoting, `~/` and
 * Tab path completion behave exactly as before.
 */
export function createFilePickerProvider(current: AutocompleteProvider, options: ProviderOptions): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, request): Promise<AutocompleteSuggestions | null> {
			const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, request);
			if (!suggestions || !options.enabled() || request.signal.aborted) return suggestions;

			const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const isAttachment = suggestions.prefix.startsWith("@");
			// Slash commands and their arguments, unless Tab explicitly asked for paths.
			if (!isAttachment && !request.force && textBeforeCursor.trimStart().startsWith("/")) return suggestions;

			const items: PickerItem[] = [];
			for (const item of suggestions.items) {
				const meta = toEntryMeta(item, suggestions.prefix);
				if (!meta) return suggestions;
				items.push({ ...item, [PICKER_META]: meta });
			}
			const sample = items.slice(0, EXISTENCE_SAMPLE);
			if (sample.length === 0 || !sample.every((item) => existsSync(options.resolve(item[PICKER_META].path)))) {
				return suggestions;
			}

			const iconSet = options.labelIcons();
			if (iconSet && iconSet !== "none") {
				for (const item of items) item.label = `${labelIcon(item[PICKER_META], iconSet)}${item.label}`;
			}
			return { prefix: suggestions.prefix, items };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

function labelIcon(meta: EntryMeta, set: IconSet): string {
	return `${iconGlyph(resolveIcon(meta.name, meta.isDirectory), set, meta.isDirectory)} `;
}
