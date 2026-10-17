import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { GitStatusCache } from "../src/git-status.ts";
import { FilePickerList, formatBytes, type PickerItem } from "../src/picker-list.ts";
import { ICON_SETS, PICKER_STYLES } from "../src/settings.ts";
import { environment, item, makeProject, stripAnsi } from "./helpers.ts";

const items: PickerItem[] = [
	item("tests/button.spec.ts", { query: "but" }),
	item("src/styles/button.css", { query: "but" }),
	item("src/components/Button.tsx", { query: "but" }),
	item("src/components/Button.test.tsx", { query: "but" }),
	item("src/components/ButtonGroup.tsx", { query: "but" }),
	item("src/components/buttons", { query: "but", directory: true }),
	item("a/really/deeply/nested/folder/structure/with/many/levels/button-with-a-very-long-name.tsx", {
		query: "but",
	}),
];

describe("FilePickerList rendering", () => {
	it("never exceeds the available width, for every style, icon set and width", () => {
		for (const style of PICKER_STYLES) {
			for (const icons of ICON_SETS) {
				for (const width of [8, 12, 20, 33, 44, 60, 80, 120, 200]) {
					const list = new FilePickerList(items, 5, environment({ style, icons }));
					list.setSelectedIndex(3);
					for (const line of list.render(width)) {
						expect(visibleWidth(line), `${style}/${icons}@${width}: ${stripAnsi(line)}`).toBeLessThanOrEqual(width);
					}
				}
			}
		}
	});

	it("shows names, parent folders and a scroll position in the columns layout", () => {
		const list = new FilePickerList(items, 4, environment({ style: "columns", icons: "none" }));
		const lines = list.render(80).map(stripAnsi);
		expect(lines[0]).toMatch(/^▌ button\.spec\.ts\s+tests\/\s*$/);
		expect(lines[2]).toContain("src/components/");
		expect(lines.at(-1)).toContain("1/7");
	});

	it("groups entries under folder headers in the tree layout", () => {
		const list = new FilePickerList(items.slice(0, 5), 8, environment({ style: "tree", icons: "none" }));
		const lines = list.render(80).map((line) => stripAnsi(line).trimEnd());
		expect(lines).toEqual([
			" tests/",
			" ╰╴button.spec.ts",
			" src/styles/",
			" ╰╴button.css",
			" src/components/",
			" ├╴Button.tsx",
			" ├╴Button.test.tsx",
			" ╰╴ButtonGroup.tsx",
		]);
	});

	it("keeps the group header visible when the tree window starts mid-group", () => {
		const list = new FilePickerList(items.slice(2, 5), 1, environment({ style: "tree", icons: "none" }));
		list.setSelectedIndex(2);
		const lines = list.render(60).map((line) => stripAnsi(line).trim());
		expect(lines[0]).toBe("src/components/");
		expect(lines).toContain("╰╴ButtonGroup.tsx");
	});

	it("maps the editor's selection index through the tree's regrouping", () => {
		const mixed = [item("a/one.ts"), item("b/two.ts"), item("a/three.ts")];
		const list = new FilePickerList(mixed, 5, environment({ style: "tree" }));
		list.setSelectedIndex(1);
		expect(list.getSelectedItem()).toBe(mixed[1]);
		list.setSelectedIndex(2);
		expect(list.getSelectedItem()).toBe(mixed[2]);
	});

	it("draws a titled card with the selected entry in the footer", () => {
		const cwd = makeProject({ "tests/button.spec.ts": "x".repeat(2048) });
		const list = new FilePickerList(items, 3, environment({ style: "card", icons: "none" }, { cwd }));
		const lines = list.render(70).map(stripAnsi);
		expect(lines[0]).toMatch(/^╭─ Files @but ─+ 1\/7 ─╮$/);
		expect(lines.at(-1)).toMatch(/^╰─ tests\/button\.spec\.ts · 2\.0 KB ─+ tab ⇥ ─╯$/);
		expect(lines.every((line) => visibleWidth(line) === 70)).toBe(true);
	});

	it("prints compact rows as full paths", () => {
		const list = new FilePickerList(items.slice(0, 2), 5, environment({ style: "compact", icons: "none" }));
		expect(list.render(60).map((line) => stripAnsi(line).trimEnd())).toEqual([
			"❯ tests/button.spec.ts",
			"  src/styles/button.css",
		]);
	});

	it("shows git badges for files and dots for folders", async () => {
		const git = new GitStatusCache(
			async (_command, args) =>
				args[0] === "rev-parse"
					? { code: 0, stdout: "/repo" }
					: { code: 0, stdout: [" M src/components/Button.tsx", "?? tests/button.spec.ts", ""].join("\0") },
			"/repo",
		);
		await git.warm(1_000);
		const list = new FilePickerList(
			[item("src/components/Button.tsx"), item("src", { directory: true }), item("tests/button.spec.ts")],
			5,
			environment({ icons: "none" }, { git }),
		);
		const lines = list.render(60).map((line) => stripAnsi(line).trimEnd());
		expect(lines[0]).toMatch(/M$/);
		expect(lines[1]).toMatch(/●$/);
		expect(lines[2]).toMatch(/U$/);
	});
});

describe("FilePickerList input", () => {
	it("wraps up and down and reports selection changes", () => {
		const list = new FilePickerList(items.slice(0, 3), 5, environment());
		const changed = vi.fn();
		list.onSelectionChange = changed;
		list.handleInput("\x1b[A");
		expect(list.getSelectedItem()).toBe(items[2]);
		list.handleInput("\x1b[B");
		expect(list.getSelectedItem()).toBe(items[0]);
		expect(changed).toHaveBeenCalledTimes(2);
	});

	it("selects the clicked row and skips folder headers", () => {
		const list = new FilePickerList(items.slice(0, 3), 5, environment({ style: "tree" }));
		const onSelect = vi.fn();
		list.onSelect = onSelect;
		list.render(60);
		const click = (y: number, type: "press" | "click") =>
			list.handleMouse({ type, button: "left", x: 4, y, screenX: 4, screenY: y, width: 60, height: 6, shift: false, alt: false, ctrl: false } as never);
		expect(click(0, "press")).toBeUndefined();
		click(3, "press");
		click(3, "click");
		expect(onSelect).toHaveBeenCalledWith(items[1]);
	});

	it("reports an empty list", () => {
		const list = new FilePickerList([], 5, environment());
		expect(stripAnsi(list.render(40)[0]!)).toBe("  No matching files");
	});
});

describe("formatBytes", () => {
	it("uses compact human units", () => {
		expect(formatBytes(980)).toBe("980 B");
		expect(formatBytes(2048)).toBe("2.0 KB");
		expect(formatBytes(15_086)).toBe("15 KB");
		expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
	});
});
