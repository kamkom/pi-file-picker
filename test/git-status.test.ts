import { describe, expect, it } from "vitest";
import { type Exec, GitStatusCache, parseStatusCode } from "../src/git-status.ts";

function fakeGit(root: string, porcelain: string[]): Exec & { calls: number } {
	const exec: Exec = async (_command, args) => {
		counted.calls++;
		if (args[0] === "rev-parse") return { code: 0, stdout: `${root}\n` };
		return { code: 0, stdout: porcelain.join("\0") };
	};
	const counted = Object.assign(exec, { calls: 0 });
	return counted;
}

describe("parseStatusCode", () => {
	it("maps porcelain XY codes", () => {
		expect(parseStatusCode("??")).toBe("untracked");
		expect(parseStatusCode(" M")).toBe("modified");
		expect(parseStatusCode("MM")).toBe("modified");
		expect(parseStatusCode("A ")).toBe("added");
		expect(parseStatusCode("D ")).toBe("deleted");
		expect(parseStatusCode("R ")).toBe("renamed");
		expect(parseStatusCode("UU")).toBe("conflicted");
		expect(parseStatusCode("!!")).toBeUndefined();
	});
});

describe("GitStatusCache", () => {
	it("resolves files and aggregates folders by the strongest state", async () => {
		const git = new GitStatusCache(
			fakeGit("/repo", [" M src/a.ts", "?? src/new.ts", "UU lib/x.ts", "R  src/b.ts", "src/old.ts", "?? scratch/", ""]),
			"/repo",
		);
		await git.warm(1_000);
		expect(git.get("src/a.ts", false)).toBe("modified");
		expect(git.get("src/new.ts", false)).toBe("untracked");
		expect(git.get("src/b.ts", false)).toBe("renamed");
		// The rename's original path is consumed, not treated as an entry.
		expect(git.get("src/old.ts", false)).toBeUndefined();
		expect(git.get("src", true)).toBe("modified");
		expect(git.get("lib", true)).toBe("conflicted");
		expect(git.get("scratch", true)).toBe("untracked");
		expect(git.get("scratch/deep/file.md", false)).toBe("untracked");
		expect(git.get("README.md", false)).toBeUndefined();
		expect(git.get("/repo/src/a.ts", false)).toBe("modified");
		expect(git.get("/elsewhere/a.ts", false)).toBeUndefined();
	});

	it("maps paths relative to a cwd below the repository root", async () => {
		const git = new GitStatusCache(fakeGit("/", [" M packages/app/index.ts", ""]), "/packages/app");
		await git.warm(1_000);
		expect(git.get("index.ts", false)).toBe("modified");
		expect(git.get("../app/index.ts", false)).toBe("modified");
	});

	it("caches until the TTL expires or the cache is marked stale", async () => {
		const exec = fakeGit("/repo", [" M a.ts", ""]);
		const git = new GitStatusCache(exec, "/repo", 60_000);
		await git.warm(1_000);
		const afterFirstLoad = exec.calls;
		git.get("a.ts", false);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(exec.calls).toBe(afterFirstLoad);
		git.markStale();
		await git.warm(1_000);
		git.get("a.ts", false);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(exec.calls).toBeGreaterThan(afterFirstLoad);
	});

	it("stays quiet outside a repository", async () => {
		const git = new GitStatusCache(async () => ({ code: 128, stdout: "" }), "/tmp");
		await git.warm(1_000);
		expect(git.get("a.ts", false)).toBeUndefined();
	});
});
