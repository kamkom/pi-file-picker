const BOUNDARY = /[\\/._\-\s]/;

function isBoundary(text: string, index: number): boolean {
	if (index === 0) return true;
	const previous = text[index - 1]!;
	if (BOUNDARY.test(previous)) return true;
	// camelCase hump: "fooBar" -> "B"
	const current = text[index]!;
	return previous === previous.toLowerCase() && current !== current.toLowerCase();
}

/**
 * Character indices of `text` to highlight for `query`.
 *
 * Prefers a contiguous case-insensitive substring (one that starts on a word boundary when there
 * are several), then falls back to an in-order subsequence. Returns [] when nothing matches.
 */
export function matchIndices(text: string, query: string): number[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [];
	const haystack = text.toLowerCase();

	let substringAt = -1;
	for (let from = haystack.indexOf(needle); from !== -1; from = haystack.indexOf(needle, from + 1)) {
		if (substringAt === -1) substringAt = from;
		if (isBoundary(text, from)) {
			substringAt = from;
			break;
		}
	}
	if (substringAt !== -1) {
		return Array.from({ length: needle.length }, (_, offset) => substringAt + offset);
	}

	const indices: number[] = [];
	let cursor = 0;
	for (const character of needle) {
		if (character === " ") continue;
		const found = haystack.indexOf(character, cursor);
		if (found === -1) return [];
		indices.push(found);
		cursor = found + 1;
	}
	return indices;
}

/** The segment of an autocomplete prefix the user is matching against: `@src/comp` -> `comp`. */
export function queryFromPrefix(prefix: string): string {
	let raw = prefix;
	if (raw.startsWith("@")) raw = raw.slice(1);
	if (raw.startsWith('"')) raw = raw.slice(1);
	const slash = raw.replace(/\\/g, "/").lastIndexOf("/");
	return slash === -1 ? raw : raw.slice(slash + 1);
}
