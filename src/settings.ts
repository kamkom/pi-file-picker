import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { IconSet } from "./icons.ts";

export const PICKER_STYLES = ["columns", "tree", "compact", "card"] as const;
export type PickerStyle = (typeof PICKER_STYLES)[number];

export const ICON_SETS: readonly IconSet[] = ["nerd", "emoji", "unicode", "none"];

export const PLACEMENTS = ["below", "above"] as const;
export type Placement = (typeof PLACEMENTS)[number];

export interface PickerSettings {
	/** Render the custom picker. When false, pi's built-in list is used. */
	enabled: boolean;
	style: PickerStyle;
	icons: IconSet;
	/** Where the list sits relative to the input box. */
	placement: Placement;
	/** Show git status badges next to changed files and folders. */
	gitStatus: boolean;
	/** Visible rows, 3-20. Unset inherits pi's `autocompleteMaxVisible`. */
	maxVisible?: number;
}

export const DEFAULT_SETTINGS: PickerSettings = {
	enabled: true,
	style: "columns",
	icons: "nerd",
	placement: "below",
	gitStatus: true,
};

export function normalizeSettings(raw: unknown): PickerSettings {
	const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const settings: PickerSettings = { ...DEFAULT_SETTINGS };
	if (typeof value.enabled === "boolean") settings.enabled = value.enabled;
	if (PICKER_STYLES.includes(value.style as PickerStyle)) settings.style = value.style as PickerStyle;
	if (ICON_SETS.includes(value.icons as IconSet)) settings.icons = value.icons as IconSet;
	if (PLACEMENTS.includes(value.placement as Placement)) settings.placement = value.placement as Placement;
	if (typeof value.gitStatus === "boolean") settings.gitStatus = value.gitStatus;
	if (typeof value.maxVisible === "number" && Number.isFinite(value.maxVisible)) {
		settings.maxVisible = Math.max(3, Math.min(20, Math.floor(value.maxVisible)));
	}
	return settings;
}

export function loadSettings(path: string): PickerSettings {
	if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
	try {
		return normalizeSettings(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function saveSettings(path: string, settings: PickerSettings): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(settings, null, "\t")}\n`);
}
