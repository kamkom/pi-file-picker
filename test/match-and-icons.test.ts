import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_FILE,
	DEFAULT_FOLDER,
	EXTENSIONS,
	FILE_NAMES,
	FILE_PREFIXES,
	FILE_SUFFIXES,
	FOLDER_NAMES,
} from "../src/icon-table.ts";
import { iconColor, iconGlyph, resolveIcon } from "../src/icons.ts";
import { matchIndices, queryFromPrefix } from "../src/match.ts";
import { colorToOklch } from "@earendil-works/pi-tui";

describe("matchIndices", () => {
	it("highlights a contiguous substring, preferring a word boundary", () => {
		expect(matchIndices("Button.tsx", "but")).toEqual([0, 1, 2]);
		// "rebutton-button": the second "but" starts after "-" so it wins.
		expect(matchIndices("rebutton-button", "but")).toEqual([9, 10, 11]);
		expect(matchIndices("useButtonGroup", "group")).toEqual([9, 10, 11, 12, 13]);
	});

	it("falls back to an in-order subsequence", () => {
		expect(matchIndices("ButtonGroup.tsx", "bgt")).toEqual([0, 6, 12]);
	});

	it("returns nothing without a match or a query", () => {
		expect(matchIndices("README.md", "xyz")).toEqual([]);
		expect(matchIndices("README.md", "")).toEqual([]);
	});
});

describe("queryFromPrefix", () => {
	it("keeps only what follows the last slash", () => {
		expect(queryFromPrefix("@src/comp")).toBe("comp");
		expect(queryFromPrefix('@"my docs/rea')).toBe("rea");
		expect(queryFromPrefix("@")).toBe("");
		expect(queryFromPrefix("./src/")).toBe("");
	});
});

describe("resolveIcon", () => {
	it("checks exact names, then compound suffixes, then prefixes, then extensions", () => {
		expect(resolveIcon("package.json", false)).toBe(FILE_NAMES["package.json"]);
		expect(resolveIcon("README.md", false)).toBe(FILE_NAMES["readme.md"]);
		expect(resolveIcon("Button.test.tsx", false)).toBe(FILE_SUFFIXES[".test.tsx"]);
		expect(resolveIcon("tsconfig.build.json", false)).toBe(FILE_PREFIXES["tsconfig."]);
		expect(resolveIcon(".env.local", false)).toBe(FILE_PREFIXES[".env."]);
		expect(resolveIcon("main.RS", false)).toBe(EXTENSIONS.rs);
		expect(resolveIcon("Makefile", false)).toBe(FILE_NAMES.makefile);
	});

	it("falls back to the default file and folder icons", () => {
		expect(resolveIcon("notes.unknown", false)).toBe(DEFAULT_FILE);
		expect(resolveIcon(".bashrc", false)).toBe(DEFAULT_FILE);
		expect(resolveIcon("whatever", true)).toBe(DEFAULT_FOLDER);
		expect(resolveIcon("node_modules", true)).toBe(FOLDER_NAMES.node_modules);
	});

	it("does not treat a bare suffix as a compound match", () => {
		expect(resolveIcon(".d.ts", false)).not.toBe(FILE_SUFFIXES[".d.ts"]);
	});
});

describe("icon glyphs", () => {
	const specs = [
		DEFAULT_FILE,
		DEFAULT_FOLDER,
		...Object.values(FILE_NAMES),
		...Object.values(FILE_PREFIXES),
		...Object.values(FILE_SUFFIXES),
		...Object.values(EXTENSIONS),
		...Object.values(FOLDER_NAMES),
	];

	it("uses one column for every Nerd Font glyph and two for every emoji", () => {
		for (const spec of specs) {
			expect(visibleWidth(spec.nerd), spec.nerd).toBe(1);
			if (spec.emoji) expect(visibleWidth(spec.emoji), spec.emoji).toBe(2);
		}
	});

	it("opens default folders when selected and keeps special ones", () => {
		expect(iconGlyph(DEFAULT_FOLDER, "nerd", true, true)).not.toBe(DEFAULT_FOLDER.nerd);
		const git = FOLDER_NAMES[".git"]!;
		expect(iconGlyph(git, "nerd", true, true)).toBe(git.nerd);
		expect(iconGlyph(DEFAULT_FILE, "unicode", false)).toBe("•");
		expect(iconGlyph(DEFAULT_FILE, "none", false)).toBe("");
	});

	it("lifts colors on dark themes and deepens them on light ones", () => {
		const darkRed = FILE_NAMES["package-lock.json"]!;
		expect(colorToOklch(iconColor(darkRed, "dark")).l).toBeGreaterThanOrEqual(0.66 - 1e-6);
		const yellow = EXTENSIONS.js!;
		expect(colorToOklch(iconColor(yellow, "light")).l).toBeLessThanOrEqual(0.55 + 1e-6);
	});
});
