/**
 * pi-file-picker: a prettier `@` file picker for pi.
 *
 * The built-in provider still finds the files; this extension tags its file suggestions and draws
 * them with Nerd Font icons, per-type colors, match highlights and git status.
 *
 *   /file-picker                  open the settings menu
 *   /file-picker style tree       columns | tree | compact | card
 *   /file-picker icons emoji      nerd | emoji | unicode | none
 *   /file-picker placement above  list over the input box (below is the default)
 *   /file-picker git off          toggle git status badges
 *   /file-picker preview          compare every style with files from the current folder
 *   /file-picker off              fall back to pi's stock list
 */

import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { installEditorHook } from "./editor-hook.ts";
import type { GitStatusCache } from "./git-status.ts";
import type { IconSet } from "./icons.ts";
import type { PickerEnvironment } from "./picker-list.ts";
import { showPreview } from "./preview.ts";
import { createPickerRuntime } from "./runtime.ts";
import {
	ICON_SETS,
	loadSettings,
	PICKER_STYLES,
	type PickerSettings,
	type PickerStyle,
	PLACEMENTS,
	type Placement,
	saveSettings,
} from "./settings.ts";

interface PickerSession {
	readonly env: PickerEnvironment;
	readonly git: GitStatusCache;
	dispose(): void;
}

export default function filePicker(pi: ExtensionAPI): void {
	const settingsPath = join(getAgentDir(), "file-picker.json");
	let settings = loadSettings(settingsPath);
	let session: PickerSession | undefined;

	const update = (ctx: ExtensionContext, patch: Partial<PickerSettings>, message: string) => {
		settings = { ...settings, ...patch };
		try {
			saveSettings(settingsPath, settings);
		} catch (error) {
			ctx.ui.notify(`file-picker: could not save ${settingsPath}: ${String(error)}`, "warning");
		}
		ctx.ui.notify(`file-picker: ${message}`, "info");
	};

	pi.on("session_start", (_event, ctx) => {
		session?.dispose();
		session = ctx.mode === "tui" ? startSession(pi, ctx, () => settings) : undefined;
	});

	pi.on("session_shutdown", () => {
		session?.dispose();
		session = undefined;
	});

	// Agent edits change git status; refresh on the next lookup instead of waiting for the TTL.
	pi.on("tool_execution_end", () => session?.git.markStale());

	pi.registerCommand("file-picker", {
		description: "Style the @ file picker: style, icons, placement, git badges, preview",
		getArgumentCompletions: (prefix) => argumentCompletions(prefix),
		handler: async (args, ctx) => {
			const [command, value] = args.trim().split(/\s+/);
			switch (command) {
				case undefined:
				case "":
					await openMenu(ctx);
					return;
				case "style":
					if (PICKER_STYLES.includes(value as PickerStyle)) update(ctx, { style: value as PickerStyle }, `style ${value}`);
					else ctx.ui.notify(`file-picker: style must be one of ${PICKER_STYLES.join(", ")}`, "warning");
					return;
				case "icons":
					if (ICON_SETS.includes(value as IconSet)) update(ctx, { icons: value as IconSet }, `icons ${value}`);
					else ctx.ui.notify(`file-picker: icons must be one of ${ICON_SETS.join(", ")}`, "warning");
					return;
				case "placement":
					if (PLACEMENTS.includes(value as Placement)) {
						update(ctx, { placement: value as Placement }, `list ${value} the input box`);
					} else {
						ctx.ui.notify(`file-picker: placement must be one of ${PLACEMENTS.join(", ")}`, "warning");
					}
					return;
				case "git":
					if (value === "on" || value === "off") update(ctx, { gitStatus: value === "on" }, `git status ${value}`);
					else ctx.ui.notify("file-picker: usage /file-picker git on|off", "warning");
					return;
				case "on":
				case "off":
					update(ctx, { enabled: command === "on" }, command === "on" ? "enabled" : "using pi's stock list");
					return;
				case "preview":
					await preview(ctx);
					return;
				default:
					ctx.ui.notify(`file-picker: unknown option "${command}"`, "warning");
			}
		},
	});

	async function openMenu(ctx: ExtensionContext): Promise<void> {
		const choices = {
			style: `Style       ${settings.style}`,
			icons: `Icons       ${settings.icons}`,
			placement: `Placement   ${settings.placement} the input box`,
			git: `Git status  ${settings.gitStatus ? "on" : "off"}`,
			enabled: `Picker      ${settings.enabled ? "on" : "off (stock list)"}`,
			preview: "Preview all styles…",
		};
		const picked = await ctx.ui.select("File picker", Object.values(choices));
		if (picked === choices.style) {
			const style = await ctx.ui.select("Picker style", [...PICKER_STYLES]);
			if (style) update(ctx, { style: style as PickerStyle }, `style ${style}`);
		} else if (picked === choices.icons) {
			const icons = await ctx.ui.select("Icon set", [...ICON_SETS]);
			if (icons) update(ctx, { icons: icons as IconSet }, `icons ${icons}`);
		} else if (picked === choices.placement) {
			const placement: Placement = settings.placement === "above" ? "below" : "above";
			update(ctx, { placement }, `list ${placement} the input box`);
		} else if (picked === choices.git) {
			update(ctx, { gitStatus: !settings.gitStatus }, `git status ${settings.gitStatus ? "off" : "on"}`);
		} else if (picked === choices.enabled) {
			update(ctx, { enabled: !settings.enabled }, settings.enabled ? "using pi's stock list" : "enabled");
		} else if (picked === choices.preview) {
			await preview(ctx);
		}
	}

	async function preview(ctx: ExtensionContext): Promise<void> {
		if (!session || ctx.mode !== "tui") {
			ctx.ui.notify("file-picker: preview needs the interactive terminal UI", "warning");
			return;
		}
		const choice = await showPreview(ctx, session.env);
		if (choice) update(ctx, choice, `style ${choice.style}, icons ${choice.icons}`);
	}
}

function startSession(pi: ExtensionAPI, ctx: ExtensionContext, getSettings: () => PickerSettings): PickerSession {
	const runtime = createPickerRuntime({
		cwd: ctx.cwd,
		exec: async (command, args, options) => {
			const result = await pi.exec(command, args, options);
			return { code: result.code, stdout: result.stdout };
		},
		theme: () => ctx.ui.theme,
		settings: getSettings,
	});

	const uninstall = installEditorHook(runtime.createList);
	if (!uninstall) {
		ctx.ui.notify("file-picker: this pi version cannot host the custom list; adding icons to the stock list", "warning");
	}
	ctx.ui.addAutocompleteProvider((current) => runtime.wrapProvider(current, !uninstall));

	// Load git status in the background so the first `@` already has badges.
	if (getSettings().gitStatus) void runtime.git.warm(0);

	return {
		env: runtime.env,
		git: runtime.git,
		dispose() {
			uninstall?.();
			runtime.dispose();
		},
	};
}

function argumentCompletions(prefix: string): AutocompleteItem[] | null {
	const [command = "", value] = prefix.trimStart().split(/\s+/);
	const options = (values: readonly string[], describe: (value: string) => string) =>
		values
			.filter((candidate) => candidate.startsWith(value ?? ""))
			.map((candidate) => ({ value: `${command} ${candidate}`, label: candidate, description: describe(candidate) }));

	if (value !== undefined) {
		switch (command) {
			case "style":
				return options(PICKER_STYLES, (style) => STYLE_DESCRIPTIONS[style as PickerStyle]);
			case "icons":
				return options(ICON_SETS, (set) => ICON_DESCRIPTIONS[set as IconSet]);
			case "placement":
				return options(PLACEMENTS, (placement) =>
					placement === "above" ? "Show the list over the input box" : "Show the list under the input box",
				);
			case "git":
				return options(["on", "off"], (state) => `${state === "on" ? "Show" : "Hide"} git status badges`);
			default:
				return null;
		}
	}
	const commands: AutocompleteItem[] = [
		{ value: "style ", label: "style", description: "columns | tree | compact | card" },
		{ value: "icons ", label: "icons", description: "nerd | emoji | unicode | none" },
		{ value: "placement ", label: "placement", description: "below | above the input box" },
		{ value: "git ", label: "git", description: "on | off" },
		{ value: "preview", label: "preview", description: "Compare every style with files from this folder" },
		{ value: "on", label: "on", description: "Use the custom picker" },
		{ value: "off", label: "off", description: "Use pi's stock list" },
	];
	const filtered = commands.filter((item) => item.label.startsWith(command));
	return filtered.length > 0 ? filtered : null;
}

const STYLE_DESCRIPTIONS: Record<PickerStyle, string> = {
	columns: "Icon and name, parent folder in a dim column, git badge on the right",
	tree: "Results grouped under their folders with tree guides and sizes",
	compact: "One path per row, fzf-like, folder part dimmed",
	card: "Rounded panel with the query, count and the selected file's details",
};

const ICON_DESCRIPTIONS: Record<IconSet, string> = {
	nerd: "Nerd Font glyphs (needs a Nerd Font in your terminal)",
	emoji: "Emoji, works in any modern terminal",
	unicode: "Plain ▸ and • markers, colored by type",
	none: "No icons, colors only",
};
