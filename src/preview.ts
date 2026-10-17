import { readdirSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { IconSet } from "./icons.ts";
import { FilePickerList, PICKER_META, type PickerEnvironment, type PickerItem } from "./picker-list.ts";
import { ICON_SETS, PICKER_STYLES, type PickerStyle } from "./settings.ts";

const SAMPLE_SIZE = 6;
const SKIPPED = new Set([".git", ".DS_Store", "node_modules"]);

/** A mix of folders and files from `cwd` (plus a couple from `src/`), shaped like `@` suggestions. */
export function sampleItems(cwd: string): PickerItem[] {
	const list = (folder: string) => {
		try {
			return readdirSync(folder, { withFileTypes: true })
				.filter((entry) => !SKIPPED.has(entry.name))
				.sort((a, b) => a.name.localeCompare(b.name));
		} catch {
			return [];
		}
	};
	const make = (parent: string, name: string, isDirectory: boolean): PickerItem => {
		const path = parent ? `${parent}/${name}` : name;
		return {
			value: `@${path}${isDirectory ? "/" : ""}`,
			label: `${name}${isDirectory ? "/" : ""}`,
			description: path,
			[PICKER_META]: { path, name, parent, isDirectory, query: "", prefix: "@" },
		};
	};

	const top = list(cwd);
	const folders = top.filter((entry) => entry.isDirectory());
	const files = top.filter((entry) => !entry.isDirectory());
	const inner = folders.find((entry) => entry.name === "src") ?? folders[0];
	const nested = inner ? list(`${cwd}/${inner.name}`).filter((entry) => !entry.isDirectory()) : [];
	return [
		...folders.slice(0, 2).map((entry) => make("", entry.name, true)),
		...nested.slice(0, 2).map((entry) => make(inner!.name, entry.name, false)),
		...files.slice(0, SAMPLE_SIZE).map((entry) => make("", entry.name, false)),
	].slice(0, SAMPLE_SIZE);
}

export interface PreviewChoice {
	style: PickerStyle;
	icons: IconSet;
}

/** One style at a time: ←/→ switch style, i cycles icons, enter applies, esc cancels. */
class PreviewComponent implements Component {
	private readonly items: PickerItem[];
	private readonly env: PickerEnvironment;
	private readonly done: (choice: PreviewChoice | undefined) => void;
	private readonly requestRender: () => void;
	private style: number;
	private icons: number;

	constructor(
		items: PickerItem[],
		env: PickerEnvironment,
		done: (choice: PreviewChoice | undefined) => void,
		requestRender: () => void,
	) {
		this.items = items;
		this.env = env;
		this.done = done;
		this.requestRender = requestRender;
		this.style = Math.max(0, PICKER_STYLES.indexOf(env.settings.style));
		this.icons = Math.max(0, ICON_SETS.indexOf(env.settings.icons));
	}

	render(width: number): string[] {
		const theme = this.env.theme;
		const style = PICKER_STYLES[this.style]!;
		const icons = ICON_SETS[this.icons]!;
		const tabs = PICKER_STYLES.map((name, index) =>
			index === this.style ? theme.style(` ${name} `, { fg: "accent", bold: true, inverse: true }) : theme.fg("muted", ` ${name} `),
		).join(" ");
		const env = withChoice(this.env, style, icons);
		const list = new FilePickerList(this.items, this.items.length, env);
		list.setSelectedIndex(1);
		const lines = [
			`${theme.style(" File picker ", { fg: "accent", bold: true })}${tabs}`,
			theme.fg("dim", ` icons: ${icons}`),
			"",
			...list.render(Math.max(20, width - 2)).map((line) => ` ${line}`),
			"",
			theme.fg("dim", " ←/→ style · i icons · enter apply · esc cancel"),
		];
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) {
			this.style = (this.style + PICKER_STYLES.length - 1) % PICKER_STYLES.length;
		} else if (matchesKey(data, "right") || matchesKey(data, "tab")) {
			this.style = (this.style + 1) % PICKER_STYLES.length;
		} else if (data === "i") {
			this.icons = (this.icons + 1) % ICON_SETS.length;
		} else if (keybindings.matches(data, "tui.select.confirm")) {
			this.done({ style: PICKER_STYLES[this.style]!, icons: ICON_SETS[this.icons]! });
		} else if (keybindings.matches(data, "tui.select.cancel")) {
			this.done(undefined);
		} else {
			return;
		}
		this.requestRender();
	}

	invalidate(): void {}
}

function withChoice(env: PickerEnvironment, style: PickerStyle, icons: IconSet): PickerEnvironment {
	return {
		get theme() {
			return env.theme;
		},
		get settings() {
			return { ...env.settings, style, icons };
		},
		get git() {
			return env.git;
		},
		resolve: env.resolve,
	};
}

export async function showPreview(ctx: ExtensionContext, env: PickerEnvironment): Promise<PreviewChoice | undefined> {
	const items = sampleItems(ctx.cwd);
	if (items.length === 0) {
		ctx.ui.notify("file-picker: nothing to preview in this folder", "info");
		return undefined;
	}
	return ctx.ui.custom<PreviewChoice | undefined>(
		(tui, _theme, _keybindings, done) => new PreviewComponent(items, env, done, () => tui.requestRender()),
	);
}
