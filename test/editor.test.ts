import { execFileSync } from "node:child_process";
import { CombinedAutocompleteProvider, Editor, SelectList } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { installEditorHook } from "../src/editor-hook.ts";
import { FilePickerList } from "../src/picker-list.ts";
import { createPickerRuntime } from "../src/runtime.ts";
import { DEFAULT_SETTINGS, type PickerSettings } from "../src/settings.ts";
import { getEditorTheme, makeProject, stripAnsi, theme } from "./helpers.ts";

const fd = execFileSync("sh", ["-c", "command -v fd || command -v fdfind || true"]).toString().trim() || null;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Internals = { autocompleteList?: unknown; isShowingAutocomplete(): boolean };

function harness(cwd: string, settings: PickerSettings = { ...DEFAULT_SETTINGS, gitStatus: false }) {
	const runtime = createPickerRuntime({
		cwd,
		exec: async () => ({ code: 1, stdout: "" }),
		theme: () => theme,
		settings: () => settings,
	});
	const uninstall = installEditorHook(runtime.createList);
	const tui = { requestRender() {}, terminal: { rows: 40, columns: 80 } };
	const editor = new Editor(tui as never, getEditorTheme(), { paddingX: 0 });
	const commands = [{ name: "model", description: "Pick a model" }];
	editor.setAutocompleteProvider(runtime.wrapProvider(new CombinedAutocompleteProvider(commands, cwd, fd), !uninstall));
	const type = async (text: string) => {
		for (const character of text) {
			editor.handleInput(character);
			await sleep(5);
		}
		const internals = editor as unknown as Internals;
		for (let waited = 0; waited < 2_000 && !internals.isShowingAutocomplete(); waited += 20) await sleep(20);
		await sleep(80);
	};
	return { editor, runtime, uninstall, type, list: () => (editor as unknown as Internals).autocompleteList };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()!();
});

describe.skipIf(!fd)("inside a real pi Editor", () => {
	const cwd = makeProject({
		"src/components/Button.tsx": "export const Button = 1;",
		"src/components/Card.tsx": "",
		"src/index.ts": "",
		"README.md": "# demo",
	});

	it("replaces the @ list with the picker and inserts the chosen path", async () => {
		const { editor, uninstall, type, list } = harness(cwd);
		cleanups.push(() => uninstall?.());
		await type("look at @butt");
		expect(list()).toBeInstanceOf(FilePickerList);
		const rendered = editor.render(80).map(stripAnsi).join("\n");
		expect(rendered).toContain("Button.tsx");
		expect(rendered).toContain("src/components/");
		editor.handleInput("\t");
		expect(editor.getText()).toBe("look at @src/components/Button.tsx ");
	});

	it("keeps the stock list for slash commands", async () => {
		const { uninstall, type, list } = harness(cwd);
		cleanups.push(() => uninstall?.());
		await type("/mod");
		expect(list()).toBeInstanceOf(SelectList);
	});

	it("drills into folders without a trailing space", async () => {
		const { editor, uninstall, type } = harness(cwd);
		cleanups.push(() => uninstall?.());
		await type("@compon");
		editor.handleInput("\r");
		expect(editor.getText()).toBe("@src/components/");
	});

	it("draws the list over the input box when placed above", async () => {
		const settings = { ...DEFAULT_SETTINGS, placement: "above" as const, gitStatus: false };
		const { editor, uninstall, type, list } = harness(cwd, settings);
		cleanups.push(() => uninstall?.());
		await type("@");
		const rows = (list() as FilePickerList).render(80).length;
		const lines = editor.render(80).map((line) => stripAnsi(line).trimEnd());
		expect(lines).toHaveLength(rows + 3);
		expect(lines[rows]).toMatch(/^─+$/);
		expect(lines[rows + 1]).toMatch(/^@/);
		expect(lines.at(-1)).toMatch(/^─+$/);
		expect(lines.slice(0, rows).join("\n")).toContain("README.md");
	});

	it("routes clicks to the list above the box and to the text below it", async () => {
		const settings = { ...DEFAULT_SETTINGS, placement: "above" as const, gitStatus: false, icons: "none" as const };
		const { editor, uninstall, type, list } = harness(cwd, settings);
		cleanups.push(() => uninstall?.());
		await type("@");
		const lines = editor.render(80).map((line) => stripAnsi(line).trim());
		const height = (list() as FilePickerList).render(80).length;
		const click = (y: number, kind: "press" | "click") =>
			editor.handleMouse({ type: kind, button: "left", x: 6, y, screenX: 6, screenY: y, width: 80, height: height + 3, shift: false, alt: false, ctrl: false } as never);

		// A click on the input row reaches the editor's own handler and leaves the list alone.
		expect(click(height + 1, "click")).toMatchObject({ handled: true });
		expect(editor.getText()).toBe("@");

		const picked = lines[1]!.replace(/^▌\s*/, "").replace(/\/$/, "");
		click(1, "press");
		click(1, "click");
		expect(editor.getText()).toContain(picked);
	});

	it("falls back to the stock list when disabled", async () => {
		const settings = { ...DEFAULT_SETTINGS, enabled: false, gitStatus: false };
		const { uninstall, type, list } = harness(cwd, settings);
		cleanups.push(() => uninstall?.());
		await type("@READ");
		expect(list()).toBeInstanceOf(SelectList);
	});
});

describe("installEditorHook", () => {
	it("restores the original methods and never stacks across reloads", () => {
		const prototype = Editor.prototype as unknown as Record<string, unknown>;
		const originals = ["createAutocompleteList", "render", "handleMouse"].map((name) => prototype[name]);
		const original = prototype.createAutocompleteList;
		const first = installEditorHook(() => undefined)!;
		const firstHook = prototype.createAutocompleteList;
		// A reload installs again without the previous runtime having cleaned up.
		const second = installEditorHook(() => undefined)!;
		expect((prototype.createAutocompleteList as Record<symbol, { original: unknown }>)[Symbol.for("pi-file-picker.editor-hook")]?.original).toBe(original);
		first();
		expect(prototype.createAutocompleteList).not.toBe(firstHook);
		second();
		expect(["createAutocompleteList", "render", "handleMouse"].map((name) => prototype[name])).toEqual(originals);
	});
});
