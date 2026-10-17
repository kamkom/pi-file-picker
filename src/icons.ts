import { type Color, colorToOklch, oklchColor, parseColor } from "@earendil-works/pi-tui";
import {
	DEFAULT_FILE,
	DEFAULT_FOLDER,
	EXTENSIONS,
	FILE_NAMES,
	FILE_PREFIXES,
	FILE_SUFFIXES,
	FOLDER_NAMES,
	type IconSpec,
	OPEN_FOLDER,
} from "./icon-table.ts";

export type IconSet = "nerd" | "emoji" | "unicode" | "none";

// Longest first so ".test.tsx" wins over ".tsx"-like overlaps and "tsconfig." over shorter prefixes.
const SUFFIXES = Object.entries(FILE_SUFFIXES).sort((a, b) => b[0].length - a[0].length);
const PREFIXES = Object.entries(FILE_PREFIXES).sort((a, b) => b[0].length - a[0].length);

export function resolveIcon(name: string, isDirectory: boolean): IconSpec {
	const lower = name.toLowerCase();
	if (isDirectory) return FOLDER_NAMES[lower] ?? DEFAULT_FOLDER;

	const exact = FILE_NAMES[lower];
	if (exact) return exact;
	for (const [suffix, spec] of SUFFIXES) {
		if (lower.endsWith(suffix) && lower.length > suffix.length) return spec;
	}
	for (const [prefix, spec] of PREFIXES) {
		if (lower.startsWith(prefix)) return spec;
	}
	const dot = lower.lastIndexOf(".");
	if (dot > 0 && dot < lower.length - 1) {
		const byExtension = EXTENSIONS[lower.slice(dot + 1)];
		if (byExtension) return byExtension;
	}
	return DEFAULT_FILE;
}

/** Glyph for an entry. Default folders swap to the open-folder glyph while selected. */
export function iconGlyph(spec: IconSpec, set: IconSet, isDirectory: boolean, open = false): string {
	switch (set) {
		case "nerd":
			return open && spec === DEFAULT_FOLDER ? OPEN_FOLDER.nerd : spec.nerd;
		case "emoji":
			if (isDirectory && open && spec === DEFAULT_FOLDER) return OPEN_FOLDER.emoji ?? "📂";
			return spec.emoji ?? (isDirectory ? "📁" : "📄");
		case "unicode":
			return isDirectory ? (open ? "▾" : "▸") : "•";
		case "none":
			return "";
	}
}

/** Terminal columns reserved for the glyph, so rows stay aligned regardless of the icon. */
export function iconColumns(set: IconSet): number {
	switch (set) {
		case "emoji":
			return 2;
		case "none":
			return 0;
		default:
			return 1;
	}
}

const colorCache = new Map<string, Color>();

/**
 * The spec color adjusted for the background: lifted on dark themes and deepened on light ones,
 * keeping hue and chroma so brand colors stay recognizable.
 */
export function iconColor(spec: IconSpec, appearance: "dark" | "light"): Color {
	const key = `${spec.color}:${appearance}`;
	let color = colorCache.get(key);
	if (!color) {
		const { l, c, h } = colorToOklch(parseColor(spec.color));
		const lightness = appearance === "dark" ? Math.max(l, 0.66) : Math.min(l, 0.55);
		color = oklchColor(lightness, c, h);
		colorCache.set(key, color);
	}
	return color;
}
