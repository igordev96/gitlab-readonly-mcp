// Directory listings at a ref: `list_tree`, the `ls-tree -z` parser, and the
// rendering. Runs entirely offline against a fixture "GitLab" built in the temp
// directory.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Config } from "../src/config.js";
import { Git } from "../src/git.js";
import { NotFoundError, RepoStore, parseTreeEntries } from "../src/repoStore.js";
import { formatTree } from "../src/tools/files.js";
import { buildFixture } from "./fixture.js";

// Its own fixture root. The trees it exposes:
//   main        src/index.tsx
//   fix/TEST-1  docs/readme.md, src/index.tsx, src/components/Button.tsx
const fixture = buildFixture(path.join(os.tmpdir(), "glmcp-fixture-tree"));

const config: Config = {
  host: pathToFileURL(fixture.root).href,
  token: "",
  cacheDir: path.join(fixture.root, "cache"),
  gitBin: "git",
  fetchMode: "ttl",
  fetchTtlSeconds: 600,
};

const store = new RepoStore(config, new Git({ bin: "git" }));

describe("list_tree", () => {
  it("lists the root one level deep", async () => {
    const result = await store.listTree("demo", "fix/TEST-1");
    assert.equal(result.path, "");
    assert.equal(result.recursive, false);
    assert.deepEqual(
      result.entries.map((entry) => [entry.type, entry.path]),
      [
        ["tree", "docs"],
        ["tree", "src"],
      ],
    );
    assert.equal(result.entries[0]?.size, undefined, "a directory has no size");
    assert.equal(result.entries[0]?.mode, "040000");
    assert.match(result.entries[0]?.object ?? "", /^[0-9a-f]{40}$/);
  });

  it("lists a subdirectory, naming entries by their full path", async () => {
    const result = await store.listTree("demo", "fix/TEST-1", "src");
    assert.equal(result.path, "src");
    assert.deepEqual(
      result.entries.map((entry) => [entry.type, entry.path]),
      [
        ["tree", "src/components"],
        ["blob", "src/index.tsx"],
      ],
    );
  });

  it("reports a blob's size in bytes", async () => {
    const listing = await store.listTree("demo", "fix/TEST-1", "src");
    const entry = listing.entries.find((candidate) => candidate.path === "src/index.tsx");
    assert.ok(entry, "src/index.tsx should be listed");
    const file = await store.readFile("demo", "fix/TEST-1", "src/index.tsx");
    assert.equal(entry.size, Buffer.byteLength(file.content, "utf8"));
  });

  it("walks the whole subtree when asked", async () => {
    const result = await store.listTree("demo", "fix/TEST-1", "", { recursive: true });
    assert.equal(result.recursive, true);
    assert.deepEqual(
      result.entries.map((entry) => entry.path),
      ["docs/readme.md", "src/components/Button.tsx", "src/index.tsx"],
    );
    assert.ok(
      result.entries.every((entry) => entry.type === "blob"),
      "a recursive listing should be files only",
    );
    assert.ok(result.entries.every((entry) => (entry.size ?? 0) > 0));
  });

  it("lists the tree of whatever ref it is given", async () => {
    // main has only src/index.tsx; fix/TEST-1 adds docs/ and src/components/.
    const result = await store.listTree("demo", "main");
    assert.deepEqual(
      result.entries.map((entry) => entry.path),
      ["src"],
    );
  });

  it("resolves a tag to the commit it points at", async () => {
    const result = await store.listTree("demo", "v1.0");
    assert.equal(result.commit, await store.resolveRef("demo", "main"));
  });

  it("carries provenance", async () => {
    const result = await store.listTree("demo", "main");
    assert.equal(result.project, "demo");
    assert.equal(result.ref, "main");
    assert.match(result.commit, /^[0-9a-f]{40}$/);
    assert.ok(result.syncedAt instanceof Date, "syncedAt should be a Date");
  });

  it("caps the entries and reports the true total", async () => {
    const result = await store.listTree("demo", "fix/TEST-1", "", {
      recursive: true,
      maxEntries: 2,
    });
    assert.equal(result.entries.length, 2);
    assert.equal(result.total, 3);
    assert.equal(result.truncated, true);
  });

  it("reports a missing directory as not found", async () => {
    await assert.rejects(
      () => store.listTree("demo", "main", "src/nope"),
      (error: unknown) => {
        assert.ok(error instanceof NotFoundError, `expected NotFoundError, got ${String(error)}`);
        assert.match(error.message, /Path not found/);
        return true;
      },
    );
  });

  it("points at get_file when the path is a file", async () => {
    // "not a tree object" is git's way of saying this; it never says which tool
    // the caller actually wanted.
    await assert.rejects(
      () => store.listTree("demo", "main", "src/index.tsx"),
      (error: unknown) => {
        assert.ok(error instanceof NotFoundError, `expected NotFoundError, got ${String(error)}`);
        assert.match(error.message, /is a file/);
        assert.match(error.message, /get_file/);
        return true;
      },
    );
  });

  it("reports a missing ref as not found, with suggestions", async () => {
    await assert.rejects(
      () => store.listTree("demo", "fix/TEST-2", "src"),
      (error: unknown) => {
        assert.ok(error instanceof NotFoundError, `expected NotFoundError, got ${String(error)}`);
        assert.match(error.message, /Ref not found/);
        assert.match(error.message, /fix\/TEST-1/);
        return true;
      },
    );
  });
});

describe("parseTreeEntries", () => {
  it("reads NUL-separated records with space-padded sizes", () => {
    // Shapes copied from real `git ls-tree -l -z` output: the size column is
    // right-aligned, and a tree's size is "-".
    const output = [
      "100644 blob 4b825dc642cb6eb9a060e54bf8d69288fbee4904    3047\tsrc/config.ts",
      "040000 tree 34cbd05f2ae5dbc7ebfe632f6166a952e0c35a87       -\tsrc/tools",
      "",
    ].join("\u0000");

    assert.deepEqual(parseTreeEntries(output), [
      {
        path: "src/config.ts",
        type: "blob",
        mode: "100644",
        object: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        size: 3047,
      },
      {
        path: "src/tools",
        type: "tree",
        mode: "040000",
        object: "34cbd05f2ae5dbc7ebfe632f6166a952e0c35a87",
        size: undefined,
      },
    ]);
  });

  it("keeps a path containing a newline as a single entry", () => {
    // Splitting the listing on newlines would forge a second entry here. Asking
    // git for `-z` output is what makes that impossible.
    const output = "100644 blob 4b825dc642cb6eb9a060e54bf8d69288fbee4904  12\twe\nird.txt\u0000";
    const entries = parseTreeEntries(output);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.path, "we\nird.txt");
    assert.equal(entries[0]?.size, 12);
  });

  it("ignores a torn record", () => {
    assert.deepEqual(parseTreeEntries("garbage-without-a-tab"), []);
    assert.deepEqual(parseTreeEntries(""), []);
  });
});

describe("formatTree", () => {
  it("wraps the listing in provenance and marks truncation", () => {
    const text = formatTree({
      project: "demo",
      ref: "main",
      commit: "a".repeat(40),
      path: "",
      recursive: false,
      entries: [
        { path: "src", type: "tree", mode: "040000", object: "b".repeat(40) },
        { path: "README.md", type: "blob", mode: "100644", object: "c".repeat(40), size: 12 },
      ],
      total: 5,
      truncated: true,
      syncedAt: new Date("2026-10-18T00:00:00.000Z"),
      fetched: false,
    });

    assert.match(text, /^<tree /);
    assert.match(text, /project="demo"/);
    assert.match(text, /ref="main"/);
    assert.match(text, /path="\/"/);
    assert.match(text, /count="2"/);
    assert.match(text, /total="5"/);
    assert.match(text, /synced_at="2026-10-18T00:00:00\.000Z"/);
    assert.match(text, /truncated="true"/);
    assert.match(text, /^tree\t-\tsrc$/m);
    assert.match(text, /^blob\t12\tREADME\.md$/m);
    assert.match(text, /\[truncated: showing 2 of 5 entries\]/);
    assert.match(text, /<\/tree>$/);
  });

  it("says so when a directory is empty, and stays quiet otherwise", () => {
    const text = formatTree({
      project: "demo",
      ref: "main",
      commit: "a".repeat(40),
      path: "empty",
      recursive: false,
      entries: [],
      total: 0,
      truncated: false,
      fetched: false,
    });

    assert.match(text, /path="empty"/);
    assert.match(text, /count="0"/);
    assert.match(text, /\(empty\)/);
    assert.doesNotMatch(text, /truncated/);
    assert.doesNotMatch(text, /total=/);
  });

  it("says when the answer came from the cache because a refresh failed", () => {
    const text = formatTree({
      project: "demo",
      ref: "main",
      commit: "a".repeat(40),
      path: "",
      recursive: false,
      entries: [{ path: "README.md", type: "blob", mode: "100644", object: "c".repeat(40), size: 12 }],
      total: 1,
      truncated: false,
      syncedAt: new Date("2026-10-18T00:00:00.000Z"),
      fetched: false,
      refreshError: "Could not reach GitLab. Check network and VPN access to the host.",
    });

    // The cached answer is still an answer, so it is served — with the reason.
    assert.match(text, /refresh_failed="true"/);
    assert.match(text, /blob\t12\tREADME\.md/);
    assert.match(text, /\[refresh failed: Could not reach GitLab/);
    assert.doesNotMatch(text, /truncated=/);
  });

  it("does not mention a refresh when there was nothing to report", () => {
    const text = formatTree({
      project: "demo",
      ref: "main",
      commit: "a".repeat(40),
      path: "",
      recursive: false,
      entries: [],
      total: 0,
      truncated: false,
      fetched: true,
    });

    assert.doesNotMatch(text, /refresh/);
  });

  it("says the age is unknown when no successful fetch has stamped the mirror", () => {
    const text = formatTree({
      project: "demo",
      ref: "main",
      commit: "a".repeat(40),
      path: "",
      recursive: false,
      entries: [],
      total: 0,
      truncated: false,
      fetched: false,
      refreshError: "Failed to fetch demo.",
    });

    // Silence would read as "nothing to report"; an unmeasured age is a fact.
    assert.match(text, /synced_at="unknown"/);
    assert.doesNotMatch(text, /synced_at="\d/);
  });
});
