import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPickerItem, PICKER_META } from "../src/picker-list.ts";
import { createFilePickerProvider, pathFromValue, toEntryMeta } from "../src/provider.ts";
import { makeProject } from "./helpers.ts";

describe("pathFromValue / toEntryMeta", () => {
	it("strips @, quotes and the trailing slash", () => {
		expect(pathFromValue("@src/index.ts")).toBe("src/index.ts");
		expect(pathFromValue('@"my docs/notes.md"')).toBe("my docs/notes.md");
		expect(pathFromValue("@src/components/")).toBe("src/components");
		expect(pathFromValue("~/Documents/")).toBe("~/Documents");
		expect(pathFromValue("/")).toBe("/");
	});

	it("describes files, folders and absolute entries", () => {
		expect(toEntryMeta({ value: "@src/components/", label: "components/" }, "@comp")).toEqual({
			path: "src/components",
			name: "components",
			parent: "src",
			isDirectory: true,
			query: "comp",
			prefix: "@comp",
		});
		expect(toEntryMeta({ value: "/etc", label: "etc" }, "/e")?.parent).toBe("/");
		expect(toEntryMeta({ value: "README.md", label: "README.md" }, "REA")?.parent).toBe("");
	});

	it("rejects items whose label is not the entry name", () => {
		expect(toEntryMeta({ value: "#123", label: "#123 fix bug" }, "#1")).toBeUndefined();
		expect(toEntryMeta({ value: "model claude", label: "claude" }, "cl")).toBeUndefined();
	});
});

function stub(suggestions: AutocompleteSuggestions | null): AutocompleteProvider {
	return {
		getSuggestions: async () => suggestions,
		applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
	};
}

describe("createFilePickerProvider", () => {
	const cwd = makeProject({ "src/index.ts": "x", "src/components/": "", "README.md": "# hi" });
	const options = { enabled: () => true, resolve: (path: string) => join(cwd, path), labelIcons: () => undefined };
	const request = { signal: new AbortController().signal };

	it("tags @ suggestions that exist on disk", async () => {
		const provider = createFilePickerProvider(
			stub({
				prefix: "@src",
				items: [
					{ value: "@src/", label: "src/", description: "src" },
					{ value: "@src/index.ts", label: "index.ts", description: "src/index.ts" },
				],
			}),
			options,
		);
		const result = await provider.getSuggestions(["@src"], 0, 4, request);
		expect(result?.items.every(isPickerItem)).toBe(true);
		const [folder, file] = result!.items as Array<ReturnType<typeof Object>>;
		expect(folder[PICKER_META]).toMatchObject({ name: "src", isDirectory: true, query: "src" });
		expect(file[PICKER_META]).toMatchObject({ path: "src/index.ts", parent: "src", isDirectory: false });
		// The completion payload itself is untouched.
		expect(result!.items[1]).toMatchObject({ value: "@src/index.ts", label: "index.ts" });
	});

	it("leaves slash commands, foreign items and missing paths alone", async () => {
		const commands = { prefix: "/mo", items: [{ value: "model", label: "model" }] };
		const commandProvider = createFilePickerProvider(stub(commands), options);
		expect(await commandProvider.getSuggestions(["/mo"], 0, 3, request)).toBe(commands);

		const issues = { prefix: "#1", items: [{ value: "#12", label: "#12", description: "[open] bug" }] };
		const issueProvider = createFilePickerProvider(stub(issues), options);
		expect(await issueProvider.getSuggestions(["#1"], 0, 2, request)).toBe(issues);

		const mentions = { prefix: "@al", items: [{ value: "@alice", label: "alice" }] };
		const mentionProvider = createFilePickerProvider(stub(mentions), options);
		expect(await mentionProvider.getSuggestions(["@al"], 0, 3, request)).toBe(mentions);
	});

	it("tags Tab path completion even inside a slash command when forced", async () => {
		const paths = { prefix: "src/", items: [{ value: "src/index.ts", label: "index.ts" }] };
		const provider = createFilePickerProvider(stub(paths), options);
		const result = await provider.getSuggestions(["/review src/"], 0, 12, { ...request, force: true });
		expect(result?.items.every(isPickerItem)).toBe(true);
	});

	it("writes icons into labels for the stock-list fallback", async () => {
		const provider = createFilePickerProvider(
			stub({ prefix: "@READ", items: [{ value: "@README.md", label: "README.md" }] }),
			{ ...options, labelIcons: () => "emoji" as const },
		);
		const result = await provider.getSuggestions(["@READ"], 0, 5, request);
		expect(result?.items[0]?.label).toBe("📖 README.md");
	});

	it("passes everything through when disabled", async () => {
		const suggestions = { prefix: "@READ", items: [{ value: "@README.md", label: "README.md" }] };
		const provider = createFilePickerProvider(stub(suggestions), { ...options, enabled: () => false });
		expect(await provider.getSuggestions(["@READ"], 0, 5, request)).toBe(suggestions);
	});
});
