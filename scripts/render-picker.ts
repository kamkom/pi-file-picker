// Renders the picker inside a real pi Editor, outside of pi: types into the editor, waits for the
// built-in fd search, and prints what the terminal would show. Used for visual checks and designs.
//
//   node scripts/render-picker.ts --cwd ../demo-app --type @but --style tree --width 90
//   node scripts/render-picker.ts --cwd . --type @ --icons emoji --theme light --down 2 --html

import { execFile, execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { CombinedAutocompleteProvider, Editor } from "@earendil-works/pi-tui";
import {
	getEditorTheme,
	initTheme,
	theme,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { installEditorHook } from "../src/editor-hook.ts";
import type { IconSet } from "../src/icons.ts";
import { createPickerRuntime } from "../src/runtime.ts";
import { DEFAULT_SETTINGS, type PickerSettings, type PickerStyle, type Placement } from "../src/settings.ts";

const { values } = parseArgs({
	options: {
		cwd: { type: "string", default: "." },
		type: { type: "string", default: "@" },
		style: { type: "string", default: DEFAULT_SETTINGS.style },
		icons: { type: "string", default: DEFAULT_SETTINGS.icons },
		placement: { type: "string", default: DEFAULT_SETTINGS.placement },
		theme: { type: "string", default: "dark" },
		width: { type: "string", default: "100" },
		max: { type: "string", default: "8" },
		down: { type: "string", default: "0" },
		git: { type: "string", default: "on" },
		stock: { type: "boolean", default: false },
		html: { type: "boolean", default: false },
	},
});

const cwd = resolve(values.cwd);
const settings: PickerSettings = {
	...DEFAULT_SETTINGS,
	enabled: !values.stock,
	style: values.style as PickerStyle,
	icons: values.icons as IconSet,
	placement: values.placement as Placement,
	gitStatus: values.git === "on",
};

initTheme(values.theme, false);

const runtime = createPickerRuntime({
	cwd,
	exec: (command, args, options) =>
		new Promise((done) => {
			execFile(command, args, { cwd: options.cwd, timeout: options.timeout }, (error, stdout) =>
				done({ code: error ? 1 : 0, stdout: String(stdout) }),
			);
		}),
	theme: () => theme,
	settings: () => settings,
});
const uninstall = installEditorHook(runtime.createList);

const tui = { requestRender() {}, terminal: { rows: 40, columns: Number(values.width) } };
const editor = new Editor(tui as never, getEditorTheme(), { paddingX: 1, autocompleteMaxVisible: Number(values.max) });
const fd = execFileSync("sh", ["-c", "command -v fd || command -v fdfind || true"]).toString().trim() || null;
editor.setAutocompleteProvider(runtime.wrapProvider(new CombinedAutocompleteProvider([], cwd, fd), !uninstall));
if (settings.gitStatus) await runtime.git.warm(3_000);

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
for (const character of values.type) {
	editor.handleInput(character);
	await sleep(15);
}
const showing = () => (editor as unknown as { isShowingAutocomplete(): boolean }).isShowingAutocomplete();
for (let waited = 0; waited < 3_000 && !showing(); waited += 25) await sleep(25);
await sleep(150);
for (let i = 0; i < Number(values.down); i++) editor.handleInput("\x1b[B");

const lines = editor.render(Number(values.width));
console.log(values.html ? toHtml(lines) : lines.join("\n"));
uninstall?.();
runtime.dispose();

/** Minimal SGR → HTML for the design renders (truecolor, bold, dim, italic, underline). */
function toHtml(rows: string[]): string {
	const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return rows
		.map((row) => {
			let out = "";
			let state: Record<string, string | undefined> = {};
			let open = false;
			const flush = () => {
				if (open) out += "</span>";
				const css = Object.entries(state)
					.filter(([, value]) => value !== undefined)
					.map(([key, value]) => `${key}:${value}`)
					.join(";");
				open = css.length > 0;
				if (open) out += `<span style="${css}">`;
			};
			for (const part of row.split(/(\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07|\x1b_[^\x1b]*\x1b\\)/)) {
				const sgr = /^\x1b\[([0-9;]*)m$/.exec(part);
				if (!sgr) {
					if (!part.startsWith("\x1b")) out += escape(part);
					continue;
				}
				const codes = (sgr[1] || "0").split(";").map(Number);
				for (let i = 0; i < codes.length; i++) {
					const code = codes[i]!;
					if (code === 0) state = {};
					else if (code === 1) state["font-weight"] = "700";
					else if (code === 2) state.opacity = "0.6";
					else if (code === 22) state["font-weight"] = state.opacity = undefined;
					else if (code === 3) state["font-style"] = "italic";
					else if (code === 23) state["font-style"] = undefined;
					else if (code === 4) state["text-decoration"] = "underline";
					else if (code === 24) state["text-decoration"] = undefined;
					else if (code === 7) state.filter = "invert(1)";
					else if (code === 27) state.filter = undefined;
					else if (code === 39) state.color = undefined;
					else if (code === 49) state.background = undefined;
					else if ((code === 38 || code === 48) && codes[i + 1] === 2) {
						const color = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
						state[code === 38 ? "color" : "background"] = color;
						i += 4;
					}
				}
				flush();
			}
			if (open) out += "</span>";
			return out;
		})
		.join("\n");
}
