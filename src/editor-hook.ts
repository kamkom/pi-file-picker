import {
	type AutocompleteItem,
	type Component,
	Editor,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

/** A list the editor can drive in place of its `SelectList`. */
export type AutocompleteList = Component & {
	onSelect?: (item: AutocompleteItem) => void;
	getSelectedItem(): AutocompleteItem | null;
	setSelectedIndex(index: number): void;
	/** "above" draws the list over the input box instead of under it. */
	readonly placement?: "above" | "below";
};

export type ListFactory = (editor: Editor, prefix: string, items: AutocompleteItem[]) => AutocompleteList | undefined;

/** Editor fields the hook reads; all present on pi-tui 1.3's `Editor`. */
interface EditorInternals {
	autocompleteList?: AutocompleteList;
	autocompleteState: unknown;
	renderedAutocompleteHeight?: number;
}

// Wrapped methods have different signatures; each wrapper declares its own parameters.
type Method = (this: Editor, ...args: any[]) => unknown;
type HookedMethod = Method & { [HOOK]?: { original: Method } };

const HOOK = Symbol.for("pi-file-picker.editor-hook");

/**
 * Routes the editor's autocomplete list through `factory`.
 *
 * pi has no public hook for how suggestions are drawn, so this wraps methods on the shared
 * `Editor` prototype, which covers the default editor and every `CustomEditor` subclass:
 *
 * - `createAutocompleteList` swaps in the factory's list. The stock list is still created first
 *   and lends its `onSelect` (the editor's own completion logic), so selection behaves as before.
 * - `render` and `handleMouse` move a list with `placement: "above"` from under the input box to
 *   over it, and shift mouse rows to match. The editor always renders its list as its last lines,
 *   so moving them keeps the list attached to the box without touching pi's layout.
 *
 * Returns an uninstall function, or undefined when this pi version has no `createAutocompleteList`.
 */
export function installEditorHook(factory: ListFactory): (() => void) | undefined {
	const prototype = Editor.prototype as unknown as Record<string, HookedMethod | undefined>;

	const restoreCreate = patch(
		prototype,
		"createAutocompleteList",
		(original) =>
			function (this: Editor, prefix: string, items: AutocompleteItem[]) {
				const list = original.call(this, prefix, items) as AutocompleteList;
				const replacement = factory(this, prefix, items);
				if (!replacement) return list;
				replacement.onSelect = list.onSelect;
				return replacement;
			},
	);
	if (!restoreCreate) return undefined;

	// Without these two the list simply stays below the box.
	const restoreRender = patch(
		prototype,
		"render",
		(original) =>
			function (this: Editor, width: number) {
				const lines = original.call(this, width) as string[];
				const height = heightAbove(this);
				return height > 0 ? [...lines.slice(-height), ...lines.slice(0, -height)] : lines;
			},
	);
	const restoreMouse = patch(
		prototype,
		"handleMouse",
		(original) =>
			function (this: Editor, event: TuiMouseEvent): TuiMouseEventResult | undefined {
				const height = heightAbove(this);
				if (height === 0) return original.call(this, event) as TuiMouseEventResult | undefined;
				if (event.y >= height) {
					return original.call(this, { ...event, y: event.y - height, height: event.height - height }) as
						| TuiMouseEventResult
						| undefined;
				}
				// Same horizontal padding the editor applies to its list.
				const paddingX = Math.min(this.getPaddingX(), Math.max(0, Math.floor((event.width - 1) / 2)));
				const list = (this as unknown as EditorInternals).autocompleteList;
				const result = list?.handleMouse?.({
					...event,
					x: event.x - paddingX,
					width: Math.max(1, event.width - paddingX * 2),
					height,
				});
				return result ? { ...result, focus: true } : undefined;
			},
	);

	return () => {
		restoreMouse?.();
		restoreRender?.();
		restoreCreate();
	};
}

/** Rows of the open list when it is drawn over the box (as of the last render), else 0. */
function heightAbove(editor: Editor): number {
	const internals = editor as unknown as EditorInternals;
	if (!internals.autocompleteState || internals.autocompleteList?.placement !== "above") return 0;
	return internals.renderedAutocompleteHeight ?? 0;
}

function patch(
	prototype: Record<string, HookedMethod | undefined>,
	name: string,
	build: (original: Method) => Method,
): (() => void) | undefined {
	const current = prototype[name];
	if (typeof current !== "function") return undefined;
	// A previous runtime (before /reload) may not have cleaned up; always wrap the real method.
	const original = current[HOOK]?.original ?? current;
	const hooked: HookedMethod = build(original);
	hooked[HOOK] = { original };
	prototype[name] = hooked;
	return () => {
		if (prototype[name] === hooked) prototype[name] = original;
	};
}
