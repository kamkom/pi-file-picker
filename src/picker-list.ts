import { readdirSync, statSync } from "node:fs";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type Component,
	getKeybindings,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { GitState, GitStatusCache } from "./git-status.ts";
import { iconColor, iconColumns, iconGlyph, resolveIcon } from "./icons.ts";
import { matchIndices } from "./match.ts";
import type { PickerSettings } from "./settings.ts";

/** Registered symbol so items stay recognizable across extension reloads. */
export const PICKER_META = Symbol.for("pi-file-picker.meta");

export interface EntryMeta {
	/** Path as it is inserted, without quotes or trailing slash: `src/index.ts`, `~/notes`, `/etc/hosts`. */
	path: string;
	name: string;
	/** Parent folder in the same notation as `path`, "" for entries at the top level. */
	parent: string;
	isDirectory: boolean;
	/** What the user typed after the last slash; drives match highlighting. */
	query: string;
	/** The whole autocomplete token, e.g. `@src/co`. */
	prefix: string;
}

export type PickerItem = AutocompleteItem & { [PICKER_META]: EntryMeta };

export function isPickerItem(item: AutocompleteItem): item is PickerItem {
	return PICKER_META in item;
}

export interface PickerEnvironment {
	readonly theme: Theme;
	readonly settings: PickerSettings;
	readonly git: GitStatusCache | undefined;
	/** Absolute file-system path for a picker path. */
	resolve(path: string): string;
}

type Row = { kind: "item"; index: number; last: boolean } | { kind: "group"; parent: string };

const ELLIPSIS = "…";
const NAME_GAP = 2;

const GIT_BADGES: Record<GitState, { letter: string; color: ThemeColor }> = {
	modified: { letter: "M", color: "warning" },
	added: { letter: "A", color: "success" },
	untracked: { letter: "U", color: "success" },
	renamed: { letter: "R", color: "accent" },
	deleted: { letter: "D", color: "error" },
	conflicted: { letter: "!", color: "error" },
};

/**
 * Drop-in replacement for the editor's autocomplete `SelectList` when the suggestions are files.
 * The editor drives it through the same surface: render, up/down input, mouse, selection, onSelect.
 */
export class FilePickerList implements Component {
	onSelect?: (item: AutocompleteItem) => void;
	onCancel?: () => void;
	onSelectionChange?: (item: AutocompleteItem) => void;

	/** Display order; the tree layout groups entries by folder. */
	private items: PickerItem[];
	private selectedIndex = 0;
	private rowTargets: (number | undefined)[] = [];
	private mousePressedIndex: number | undefined;

	private readonly original: PickerItem[];
	private readonly maxVisible: number;
	private readonly env: PickerEnvironment;

	constructor(items: PickerItem[], maxVisible: number, env: PickerEnvironment) {
		this.original = items;
		this.maxVisible = maxVisible;
		this.env = env;
		this.items = env.settings.style === "tree" ? groupByParent(items) : items;
	}

	/** Read by the editor hook: "above" draws the list over the input box. */
	get placement(): "above" | "below" {
		return this.env.settings.placement;
	}

	/** `index` addresses the suggestion order the editor knows about. */
	setSelectedIndex(index: number): void {
		const item = this.original[Math.max(0, Math.min(index, this.original.length - 1))];
		const displayIndex = item ? this.items.indexOf(item) : 0;
		this.selectedIndex = Math.max(0, displayIndex);
	}

	setFilter(filter: string): void {
		const lower = filter.toLowerCase();
		this.items = this.items.filter((item) => item.value.toLowerCase().startsWith(lower));
		this.selectedIndex = 0;
	}

	getSelectedItem(): AutocompleteItem | null {
		return this.items[this.selectedIndex] ?? null;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.items.length === 0) return;
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.up")) {
			this.move(-1);
		} else if (keybindings.matches(data, "tui.select.down")) {
			this.move(1);
		} else if (keybindings.matches(data, "tui.select.confirm")) {
			const item = this.getSelectedItem();
			if (item) this.onSelect?.(item);
		} else if (keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.items.length === 0) return undefined;
		if (event.type === "wheel" && event.wheelDelta) {
			const before = this.selectedIndex;
			this.selectedIndex = clamp(this.selectedIndex + (event.wheelDelta < 0 ? -1 : 1), 0, this.items.length - 1);
			if (this.selectedIndex !== before) this.notifySelectionChange();
			return { handled: true, render: this.selectedIndex !== before };
		}
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		const target = this.rowTargets[event.y];
		if (target === undefined) return undefined;
		if (event.type === "press") {
			this.mousePressedIndex = target;
			if (this.selectedIndex !== target) {
				this.selectedIndex = target;
				this.notifySelectionChange();
			}
			return { handled: true, focus: true };
		}
		this.selectedIndex = this.mousePressedIndex ?? target;
		this.mousePressedIndex = undefined;
		const item = this.getSelectedItem();
		if (item) this.onSelect?.(item);
		return { handled: true };
	}

	render(width: number): string[] {
		this.rowTargets = [];
		const theme = this.env.theme;
		if (this.items.length === 0) return [theme.fg("muted", "  No matching files")];
		if (width < 12) return this.renderCompact(width);
		switch (this.env.settings.style) {
			case "tree":
				return this.renderTree(width);
			case "compact":
				return this.renderCompact(width);
			case "card":
				return width >= 30 ? this.renderCard(width) : this.renderColumns(width);
			default:
				return this.renderColumns(width);
		}
	}

	// ── layouts ────────────────────────────────────────────────────────────

	private renderColumns(width: number): string[] {
		const lines: string[] = [];
		const { start, end } = this.window(this.maxVisible);
		const detailMode = sharesParent(this.items);
		const nameWidth = this.nameColumnWidth(width);
		for (let i = start; i < end; i++) {
			this.rowTargets[lines.length] = i;
			lines.push(this.columnsRow(this.items[i]!, i === this.selectedIndex, width, nameWidth, detailMode));
		}
		const footer = this.scrollFooter(start, end, width);
		if (footer) lines.push(footer);
		return lines;
	}

	private renderCompact(width: number): string[] {
		const theme = this.env.theme;
		const lines: string[] = [];
		const { start, end } = this.window(this.maxVisible);
		for (let i = start; i < end; i++) {
			const item = this.items[i]!;
			const meta = item[PICKER_META];
			const selected = i === this.selectedIndex;
			const pointer = selected ? theme.fg("accent", "❯") : " ";
			const icon = this.icon(meta, selected);
			const badge = this.badge(meta);
			const room = width - 2 - visibleWidth(icon) - 2;
			const path = this.compactPath(meta, selected, Math.max(1, room));
			this.rowTargets[lines.length] = i;
			lines.push(joinEdges(`${pointer} ${icon}${path}`, `${badge} `, width));
		}
		const footer = this.scrollFooter(start, end, width);
		if (footer) lines.push(footer);
		return lines;
	}

	private renderTree(width: number): string[] {
		const theme = this.env.theme;
		const rows = buildRows(this.items);
		const height = Math.min(rows.length, this.maxVisible + 2);
		const selectedRow = rows.findIndex((row) => row.kind === "item" && row.index === this.selectedIndex);
		const start = clamp(selectedRow - Math.floor(height / 2), 0, Math.max(0, rows.length - height));
		let visible = rows.slice(start, start + height);

		// Keep the current group's folder on screen when the window opens mid-group.
		const first = visible[0];
		if (first?.kind === "item") {
			const header: Row = { kind: "group", parent: this.items[first.index]![PICKER_META].parent };
			const lastVisible = visible[visible.length - 1];
			const selectedAtBottom = lastVisible?.kind === "item" && lastVisible.index === this.selectedIndex;
			visible = selectedAtBottom || visible.length === 1 ? [header, ...visible.slice(1)] : [header, ...visible.slice(0, -1)];
			if (visible.length === 1) visible.push(first);
		}

		const lines: string[] = [];
		for (const row of visible) {
			if (row.kind === "group") {
				this.rowTargets[lines.length] = undefined;
				lines.push(this.treeHeader(row.parent, width));
				continue;
			}
			this.rowTargets[lines.length] = row.index;
			lines.push(this.treeRow(this.items[row.index]!, row.index === this.selectedIndex, row.last, width));
		}
		if (rows.length > height) {
			const arrows = `${start > 0 ? "↑" : " "}${start + height < rows.length ? "↓" : " "}`;
			lines.push(fit(`  ${theme.fg("dim", `${arrows} ${this.selectedIndex + 1}/${this.items.length}`)}`, width));
		}
		return lines;
	}

	private renderCard(width: number): string[] {
		const theme = this.env.theme;
		const inner = width - 2;
		const border = (text: string) => theme.fg("border", text);
		const { start, end } = this.window(this.maxVisible);
		const detailMode = sharesParent(this.items);
		const nameWidth = this.nameColumnWidth(inner);
		const meta = this.items[this.selectedIndex]?.[PICKER_META];

		const title = `${theme.style("Files", { fg: "accent", bold: true })} ${theme.fg("muted", meta?.prefix ?? "")}`;
		const count = theme.fg("dim", `${this.selectedIndex + 1}/${this.items.length}`);
		const lines = [boxLine(border("╭─ "), title, count, border(" ─╮"), border, width)];
		for (let i = start; i < end; i++) {
			this.rowTargets[lines.length] = i;
			const row = this.columnsRow(this.items[i]!, i === this.selectedIndex, inner, nameWidth, detailMode);
			lines.push(`${border("│")}${row}${border("│")}`);
		}
		let footer = "";
		if (meta) {
			const detail = this.detail(meta);
			footer = theme.fg("muted", meta.path + (meta.isDirectory ? "/" : ""));
			if (detail) footer += theme.fg("dim", ` · ${detail}`);
		}
		const hints = theme.fg("dim", "tab ⇥");
		lines.push(boxLine(border("╰─ "), footer, hints, border(" ─╯"), border, width));
		return lines;
	}

	// ── rows ───────────────────────────────────────────────────────────────

	private columnsRow(item: PickerItem, selected: boolean, width: number, nameWidth: number, detailMode: boolean): string {
		const theme = this.env.theme;
		const meta = item[PICKER_META];
		const marker = selected ? theme.fg("accent", "▌") : " ";
		const left = `${marker} ${this.icon(meta, selected)}`;
		const right = ` ${this.badge(meta)} `;
		const middle = Math.max(1, width - visibleWidth(left) - visibleWidth(right));

		const nameCells = Math.min(nameWidth, middle);
		const nameHits = matchIndices(meta.name, meta.query);
		let body = padTo(this.name(meta, selected, nameCells, nameHits), nameCells);

		const sideWidth = middle - nameCells - NAME_GAP;
		if (sideWidth >= 6) {
			const side = detailMode
				? theme.fg("dim", truncateToWidth(this.detail(meta), sideWidth, ELLIPSIS))
				: this.parentPath(meta, selected, sideWidth, nameHits.length === 0);
			body += " ".repeat(NAME_GAP) + side;
		}
		const line = left + padTo(body, middle) + right;
		return selected ? this.env.theme.bg("selectedBg", fit(line, width)) : fit(line, width);
	}

	private treeHeader(parent: string, width: number): string {
		const theme = this.env.theme;
		const label = folderPrefix(parent, "./");
		const name = parent === "/" ? "/" : parent ? (parent.split("/").pop() ?? parent) : ".";
		const icon = this.icon({ path: parent, name, parent: "", isDirectory: true, query: "", prefix: "" }, true);
		return fit(` ${icon}${theme.fg("muted", label)}`, width);
	}

	private treeRow(item: PickerItem, selected: boolean, last: boolean, width: number): string {
		const theme = this.env.theme;
		const meta = item[PICKER_META];
		const branch = theme.fg("borderMuted", last ? " ╰╴" : " ├╴");
		const left = `${branch}${this.icon(meta, selected)}`;
		const detail = this.detail(meta);
		const right = `${detail ? theme.fg("dim", detail) : ""} ${this.badge(meta)} `;
		const room = Math.max(1, width - visibleWidth(left) - visibleWidth(right) - 1);
		const name = this.name(meta, selected, room, matchIndices(meta.name, meta.query));
		const line = joinEdges(left + name, right, width);
		return selected ? theme.bg("selectedBg", line) : line;
	}

	// ── cells ──────────────────────────────────────────────────────────────

	private icon(meta: EntryMeta, open: boolean): string {
		const set = this.env.settings.icons;
		if (set === "none") return "";
		const spec = resolveIcon(meta.name, meta.isDirectory);
		const glyph = iconGlyph(spec, set, meta.isDirectory, open && meta.isDirectory);
		const padding = Math.max(0, iconColumns(set) - visibleWidth(glyph));
		return `${this.env.theme.style(glyph, { fg: iconColor(spec, this.env.theme.appearance) })}${" ".repeat(padding)} `;
	}

	/** File or folder name, truncated to `width`, with match highlights; folders get a dim trailing slash. */
	private name(meta: EntryMeta, selected: boolean, width: number, hits: readonly number[]): string {
		const theme = this.env.theme;
		const slash = meta.isDirectory ? 1 : 0;
		const shown = clipEnd(meta.name, Math.max(1, width - slash));
		const base = meta.isDirectory
			? (text: string) =>
					theme.style(text, { fg: iconColor(resolveIcon(meta.name, true), theme.appearance), bold: true })
			: (text: string) => (selected ? theme.style(text, { fg: "text", bold: true }) : theme.fg("text", text));
		const hit = (text: string) => theme.style(text, { fg: "accent", bold: true, underline: true });
		const name = paintHits(shown.text, shiftHits(hits, 0, shown.kept), base, hit);
		return slash ? `${name}${theme.fg("dim", "/")}` : name;
	}

	/** Parent folder for the side column, clipped from the left so the nearest folders stay visible. */
	private parentPath(meta: EntryMeta, selected: boolean, width: number, highlight: boolean): string {
		const theme = this.env.theme;
		const text = folderPrefix(meta.parent, "");
		if (!text) return "";
		const shown = clipStart(text, width);
		const hits = highlight ? shiftHits(matchIndices(text, meta.query), shown.dropped - shown.prefix, shown.text.length) : [];
		const base = (part: string) => theme.fg(selected ? "muted" : "dim", part);
		return paintHits(shown.text, hits, base, (part) => theme.style(part, { fg: "accent", underline: true }));
	}

	/** Whole path with a dim folder part and a bright name, for the compact layout. */
	private compactPath(meta: EntryMeta, selected: boolean, width: number): string {
		const theme = this.env.theme;
		const folder = folderPrefix(meta.parent, "");
		const full = `${folder}${meta.name}${meta.isDirectory ? "/" : ""}`;
		const shown = clipStart(full, width);
		let hits = matchIndices(meta.name, meta.query).map((index) => index + folder.length);
		if (hits.length === 0) hits = matchIndices(folder, meta.query);
		hits = shiftHits(hits, shown.dropped - shown.prefix, shown.text.length);
		const nameStart = folder.length - shown.dropped + shown.prefix;
		const hit = (part: string) => theme.style(part, { fg: "accent", bold: true, underline: true });
		let out = "";
		for (let i = 0; i < shown.text.length; i++) {
			const character = shown.text[i]!;
			if (hits.includes(i)) out += hit(character);
			else if (i < nameStart) out += theme.fg("dim", character);
			else if (meta.isDirectory) out += theme.style(character, { fg: iconColor(resolveIcon(meta.name, true), theme.appearance), bold: true });
			else out += selected ? theme.style(character, { fg: "text", bold: true }) : theme.fg("text", character);
		}
		return out;
	}

	private badge(meta: EntryMeta): string {
		const state = this.env.git?.get(meta.path, meta.isDirectory);
		if (!state) return " ";
		const badge = GIT_BADGES[state];
		return this.env.theme.fg(badge.color, meta.isDirectory ? "●" : badge.letter);
	}

	private detail(meta: EntryMeta): string {
		return entryDetail(this.env.resolve(meta.path), meta.isDirectory);
	}

	// ── helpers ────────────────────────────────────────────────────────────

	private nameColumnWidth(width: number): number {
		const iconWidth = this.env.settings.icons === "none" ? 0 : iconColumns(this.env.settings.icons) + 1;
		const middle = width - 2 - iconWidth - 3;
		const widest = this.items.reduce(
			(max, item) => Math.max(max, visibleWidth(item[PICKER_META].name) + (item[PICKER_META].isDirectory ? 1 : 0)),
			0,
		);
		const cap = Math.max(12, Math.floor(middle * 0.55));
		return Math.max(Math.min(widest, cap), Math.min(12, middle));
	}

	private window(size: number): { start: number; end: number } {
		const start = clamp(this.selectedIndex - Math.floor(size / 2), 0, Math.max(0, this.items.length - size));
		return { start, end: Math.min(start + size, this.items.length) };
	}

	private scrollFooter(start: number, end: number, width: number): string | undefined {
		if (start === 0 && end >= this.items.length) return undefined;
		const theme = this.env.theme;
		const arrows = `${start > 0 ? "↑" : " "}${end < this.items.length ? "↓" : " "}`;
		return fit(`  ${theme.fg("dim", `${arrows} ${this.selectedIndex + 1}/${this.items.length}`)}`, width);
	}

	private move(delta: number): void {
		const count = this.items.length;
		this.selectedIndex = (this.selectedIndex + delta + count) % count;
		this.notifySelectionChange();
	}

	private notifySelectionChange(): void {
		const item = this.getSelectedItem();
		if (item) this.onSelectionChange?.(item);
	}
}

// ── pure helpers ──────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

/** `src` -> `src/`, `/` stays `/`, the top level becomes `topLevel`. */
function folderPrefix(parent: string, topLevel: string): string {
	if (!parent) return topLevel;
	return parent.endsWith("/") ? parent : `${parent}/`;
}

function padTo(text: string, width: number): string {
	const visible = visibleWidth(text);
	return visible >= width ? text : text + " ".repeat(width - visible);
}

function fit(text: string, width: number): string {
	return padTo(truncateToWidth(text, width, ""), width);
}

/** Left content and a right-aligned tail on one line of exactly `width` columns. */
function joinEdges(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return fit(left, width);
	return padTo(truncateToWidth(left, width - rightWidth, ""), width - rightWidth) + right;
}

/** `╭─ title ───── tail ─╮`: the tail is dropped first, then the title is clipped, when space runs out. */
function boxLine(
	open: string,
	title: string,
	tail: string,
	close: string,
	rule: (text: string) => string,
	width: number,
): string {
	const fixed = visibleWidth(open) + visibleWidth(close);
	const tailText = tail && fixed + visibleWidth(title) + visibleWidth(tail) + 3 <= width ? ` ${tail}` : "";
	const titleText = truncateToWidth(title, Math.max(0, width - fixed - visibleWidth(tailText) - 1), ELLIPSIS);
	const gap = Math.max(0, width - fixed - visibleWidth(titleText) - 1 - visibleWidth(tailText));
	return fit(`${open}${titleText} ${rule("─".repeat(gap))}${tailText}${close}`, width);
}

/** End-truncate plain text; `kept` is how many leading characters survived. */
function clipEnd(text: string, width: number): { text: string; kept: number } {
	if (visibleWidth(text) <= width) return { text, kept: text.length };
	const clipped = truncateToWidth(text, width, ELLIPSIS);
	const kept = clipped.endsWith(ELLIPSIS) ? clipped.length - ELLIPSIS.length : clipped.length;
	return { text: clipped, kept };
}

/** Start-truncate plain text to `width`, prefixing an ellipsis; reports how many characters were cut. */
function clipStart(text: string, width: number): { text: string; dropped: number; prefix: number } {
	if (visibleWidth(text) <= width) return { text, dropped: 0, prefix: 0 };
	const characters = Array.from(text);
	let tail = "";
	for (let i = characters.length - 1; i >= 0; i--) {
		const candidate = characters[i]! + tail;
		if (visibleWidth(candidate) > width - 1) break;
		tail = candidate;
	}
	return { text: ELLIPSIS + tail, dropped: text.length - tail.length, prefix: ELLIPSIS.length };
}

/** Move highlight indices by `-offset` and keep those inside `[0, limit)`. */
function shiftHits(hits: readonly number[], offset: number, limit: number): number[] {
	return hits.map((index) => index - offset).filter((index) => index >= 0 && index < limit);
}

function paintHits(text: string, hits: readonly number[], base: (part: string) => string, hit: (part: string) => string): string {
	if (hits.length === 0) return base(text);
	const marks = new Set(hits);
	let out = "";
	let run = "";
	let runIsHit = false;
	for (let i = 0; i < text.length; i++) {
		const isHit = marks.has(i);
		if (run && isHit !== runIsHit) {
			out += runIsHit ? hit(run) : base(run);
			run = "";
		}
		run += text[i];
		runIsHit = isHit;
	}
	if (run) out += runIsHit ? hit(run) : base(run);
	return out;
}

function sharesParent(items: readonly PickerItem[]): boolean {
	if (items.length < 2) return false;
	const parent = items[0]![PICKER_META].parent;
	return items.every((item) => item[PICKER_META].parent === parent);
}

/** Stable grouping by parent folder; groups keep the rank of their best entry. */
function groupByParent(items: readonly PickerItem[]): PickerItem[] {
	const groups = new Map<string, PickerItem[]>();
	for (const item of items) {
		const parent = item[PICKER_META].parent;
		const group = groups.get(parent);
		if (group) group.push(item);
		else groups.set(parent, [item]);
	}
	return [...groups.values()].flat();
}

function buildRows(items: readonly PickerItem[]): Row[] {
	const rows: Row[] = [];
	items.forEach((item, index) => {
		const parent = item[PICKER_META].parent;
		if (index === 0 || items[index - 1]![PICKER_META].parent !== parent) rows.push({ kind: "group", parent });
		const next = items[index + 1];
		rows.push({ kind: "item", index, last: !next || next[PICKER_META].parent !== parent });
	});
	return rows;
}

const detailCache = new Map<string, { text: string; at: number }>();
const DETAIL_TTL_MS = 5_000;

/** "4.2 KB" for files, "12 items" for folders; "" when the entry cannot be read. */
export function entryDetail(absolutePath: string, isDirectory: boolean): string {
	const now = Date.now();
	const cached = detailCache.get(absolutePath);
	if (cached && now - cached.at < DETAIL_TTL_MS) return cached.text;
	let text = "";
	try {
		if (isDirectory) {
			const count = readdirSync(absolutePath).length;
			text = `${count} ${count === 1 ? "item" : "items"}`;
		} else {
			text = formatBytes(statSync(absolutePath).size);
		}
	} catch {}
	if (detailCache.size > 2_000) detailCache.clear();
	detailCache.set(absolutePath, { text, at: now });
	return text;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
