// Diff & history, phase 3a: `log` and `get_commit`.
// Runs offline against the fixture "GitLab", with a real merge, a real rename
// and a binary file, because those are the shapes the parsers have to survive.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Config } from "../src/config.js";
import { Git } from "../src/git.js";
import {
  NotFoundError,
  RepoStore,
  blameDate,
  parseBlame,
  parseCommitMetadata,
  parseLogEntries,
  parseNameStatus,
  parseNumstat,
  type BlameResult,
  type CommitResult,
  type CompareResult,
  type DiffFileResult,
  type LogResult,
} from "../src/repoStore.js";
import { formatBlame, formatCommit, formatCompare, formatDiffFile, formatLog, parseLineSpec } from "../src/tools/history.js";
import {
  addBranchWithFile,
  addMergedBranch,
  addOrphanBranch,
  buildFixture,
  commitOnBranch,
  renameOnBranch,
} from "./fixture.js";

const fixture = buildFixture(path.join(os.tmpdir(), "glmcp-fixture-history"));
const cacheDir = path.join(fixture.root, "cache");

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: pathToFileURL(fixture.root).href,
    token: "",
    cacheDir,
    gitBin: "git",
    fetchMode: "ttl",
    fetchTtlSeconds: 600,
    ...overrides,
  };
}

// Enough lines for git to call it a rename rather than a delete plus an add.
const manyLines = Array.from({ length: 8 }, (_, index) => `export const line${index + 1} = ${index + 1};`);
addBranchWithFile(fixture.work, "feat/RENAME", "src/many.ts", `${manyLines.join("\n")}\n`, "add many-line file");
renameOnBranch(
  fixture.work,
  "feat/RENAME",
  "src/many.ts",
  "src/renamed.ts",
  `${[...manyLines.slice(0, 4), "export const line5 = 'changed';", ...manyLines.slice(5)].join("\n")}\n`,
  "rename many-line file",
);
addBranchWithFile(fixture.work, "feat/BINARY", "assets/logo.bin", "A\u0000B\u0001\n", "add binary asset");
addMergedBranch(fixture.work, "feat/MERGE", "src/merged.ts", "export const merged = true;\n", "merge feat/MERGE");

// A file edited in the middle, so `diff_file`'s context width has something to
// show and something to hide.
const tenRows = Array.from({ length: 10 }, (_, index) => `export const row${index + 1} = ${index + 1};`);
addBranchWithFile(fixture.work, "feat/CTX", "src/context.ts", `${tenRows.join("\n")}\n`, "add context file");
commitOnBranch(
  fixture.work,
  "feat/CTX",
  "src/context.ts",
  `${[...tenRows.slice(0, 4), "export const row5 = 'edited';", ...tenRows.slice(5)].join("\n")}\n`,
  "edit a middle line",
);

// A second root: `git merge-base` answers nothing across it.
addOrphanBranch(fixture.work, "feat/ORPHAN", "src/orphan.ts", "export const orphan = true;\n");

const store = new RepoStore(makeConfig(), new Git({ bin: "git" }));

describe("log", () => {
  it("lists commits newest first and marks a merge", async () => {
    const result = await store.log("demo");
    assert.equal(result.project, "demo");
    assert.equal(result.ref, "main");
    assert.match(result.commit, /^[0-9a-f]{40}$/);
    assert.equal(result.entries[0]?.subject, "merge feat/MERGE");
    assert.equal(result.entries[0]?.merge, true);
    assert.equal(result.entries[0]?.parents.length, 2);
    assert.deepEqual(
      result.entries.map((entry) => entry.subject),
      ["merge feat/MERGE", "branch work", "initial"],
    );
    assert.equal(result.entries[1]?.merge, false);
    assert.equal(result.truncated, false);
    assert.ok(result.syncedAt instanceof Date);
  });

  it("walks the ref it is given, with the resolved commit", async () => {
    const result = await store.log("demo", { ref: "fix/TEST-1" });
    assert.equal(result.ref, "fix/TEST-1");
    assert.deepEqual(
      result.entries.map((entry) => entry.subject),
      ["branch change", "initial"],
    );
    assert.equal(result.entries[0]?.commit, result.commit);
    assert.ok((result.entries[0]?.commit ?? "").startsWith(result.entries[0]?.short ?? "!"));
    assert.equal(result.entries[0]?.author, "Test");
    assert.match(result.entries[0]?.date ?? "", /^\d{4}-\d{2}-\d{2}T/);
  });

  it("accepts a commit sha as the ref", async () => {
    const both = await store.log("demo", { ref: "fix/TEST-1" });
    const initialSha = both.entries[1]?.commit ?? "";
    const fromSha = await store.log("demo", { ref: initialSha });
    assert.deepEqual(
      fromSha.entries.map((entry) => entry.subject),
      ["initial"],
    );
  });

  it("filters by path", async () => {
    const result = await store.log("demo", { ref: "fix/TEST-1", path: "docs/readme.md" });
    assert.deepEqual(
      result.entries.map((entry) => entry.subject),
      ["branch change"],
    );
  });

  it("returns an empty list, not an error, when the path matches nothing", async () => {
    const result = await store.log("demo", { ref: "fix/TEST-1", path: "src/nope.ts" });
    assert.deepEqual(result.entries, []);
    assert.equal(result.truncated, false);
  });

  it("caps at limit and says so", async () => {
    const result = await store.log("demo", { ref: "fix/TEST-1", limit: 1 });
    assert.equal(result.entries.length, 1);
    assert.equal(result.truncated, true);
    assert.equal(result.outputTruncated, false);
  });

  it("reports a missing ref as NotFoundError", async () => {
    await assert.rejects(store.log("demo", { ref: "no/such-branch" }), NotFoundError);
  });
});

describe("get_commit", () => {
  it("reads metadata, the message and the changed files", async () => {
    const result = await store.getCommit("demo", "fix/TEST-1");
    assert.equal(result.rev, "fix/TEST-1");
    assert.match(result.commit, /^[0-9a-f]{40}$/);
    assert.equal(result.parents.length, 1);
    assert.equal(result.author, "Test");
    assert.equal(result.authorEmail, "test@example.com");
    assert.match(result.authoredAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(result.message.trim(), "branch change");
    assert.equal(result.merge, false);

    assert.deepEqual(
      result.files.map((file) => [file.status, file.path]),
      [
        ["A", "docs/readme.md"],
        ["A", "src/components/Button.tsx"],
        ["M", "src/index.tsx"],
      ],
    );
    assert.equal(result.additions, 3);
    assert.equal(result.deletions, 1);
    assert.equal(result.patch, undefined);
  });

  it("accepts an abbreviated sha", async () => {
    const full = await store.getCommit("demo", "fix/TEST-1");
    const short = await store.getCommit("demo", full.commit.slice(0, 8));
    assert.equal(short.commit, full.commit);
  });

  it("appends the patch only when asked", async () => {
    const result = await store.getCommit("demo", "fix/TEST-1", { patch: true });
    assert.match(result.patch ?? "", /^diff --git a\/src\/index\.tsx b\/src\/index\.tsx/m);
    assert.match(result.patch ?? "", /\+export const hello = 'fix\/TEST-1';/);
    assert.match(result.patch ?? "", /-export const hello = 'main';/);
    assert.equal(result.patchTruncated, false);
  });

  it("reports a rename with both paths", async () => {
    const result = await store.getCommit("demo", "feat/RENAME");
    const renamed = result.files.find((file) => file.oldPath !== undefined);
    assert.ok(renamed, `expected a rename; saw ${JSON.stringify(result.files)}`);
    assert.match(renamed?.status ?? "", /^R\d+$/);
    assert.equal(renamed?.oldPath, "src/many.ts");
    assert.equal(renamed?.path, "src/renamed.ts");
    assert.equal(renamed?.additions, 1);
    assert.equal(renamed?.deletions, 1);
  });

  it("marks a binary file instead of inventing counts", async () => {
    const result = await store.getCommit("demo", "feat/BINARY");
    const binary = result.files.find((file) => file.binary);
    assert.ok(binary, `expected a binary file; saw ${JSON.stringify(result.files)}`);
    assert.equal(binary?.path, "assets/logo.bin");
    assert.equal(binary?.additions, undefined);
    assert.equal(binary?.deletions, undefined);
    assert.equal(result.additions, 0);
    assert.equal(result.deletions, 0);
  });

  it("explains a merge commit and reports no file list", async () => {
    const result = await store.getCommit("demo", "main", { patch: true });
    assert.equal(result.merge, true);
    assert.equal(result.parents.length, 2);
    assert.deepEqual(result.files, []);
    assert.equal(result.patch, undefined);
    assert.equal(result.message.trim(), "merge feat/MERGE");
  });

  it("reports a missing revision as NotFoundError", async () => {
    await assert.rejects(store.getCommit("demo", "no-such-rev"), NotFoundError);
  });
});

describe("history parsers", () => {
  const sha1 = "a".repeat(40);
  const sha2 = "b".repeat(40);
  const record = (fields: string[]): string => `${fields.join("\u001f")}\u001e`;

  it("parses log records, including a subject with tabs and a separator", () => {
    const output =
      record([sha1, "aaaaaaa", "", "Ana", "2026-01-02T03:04:05+01:00", "one\twith\ttabs"]) +
      "\u0000" +
      record([sha2, "bbbbbbb", `${sha1} ${"c".repeat(40)}`, "Bo", "2026-01-01T00:00:00Z", "sub\u001fject"]) +
      "\u0000";
    const entries = parseLogEntries(output);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.subject, "one\twith\ttabs");
    assert.deepEqual(entries[0]?.parents, []);
    assert.equal(entries[0]?.merge, false);
    assert.equal(entries[1]?.subject, "sub\u001fject");
    assert.equal(entries[1]?.merge, true);
  });

  it("drops a log record the byte cap tore", () => {
    const output = record([sha1, "aaaaaaa", "", "Ana", "2026-01-02T03:04:05+01:00", "complete"]) + "\u0000" +
      record([sha2, "bbbbbbb", "", "Bo", "2026-01-01T00:00:00Z", "torn"]).slice(0, -1);
    const entries = parseLogEntries(output);
    assert.deepEqual(
      entries.map((entry) => entry.subject),
      ["complete"],
    );
  });

  it("parses name-status records, renames included", () => {
    const entries = parseNameStatus(
      "M\u0000src/a.ts\u0000R091\u0000old.ts\u0000new.ts\u0000D\u0000gone.ts\u0000",
    );
    assert.deepEqual(entries, [
      { status: "M", path: "src/a.ts" },
      { status: "R091", path: "new.ts", oldPath: "old.ts" },
      { status: "D", path: "gone.ts" },
    ]);
  });

  it("parses numstat records, renames and binaries included", () => {
    const entries = parseNumstat(
      "3\t1\tsrc/a.ts\u00001\t1\t\u0000old.ts\u0000new.ts\u0000-\t-\tassets/x.bin\u0000",
    );
    assert.deepEqual(entries, [
      { path: "src/a.ts", binary: false, additions: 3, deletions: 1 },
      { path: "new.ts", oldPath: "old.ts", binary: false, additions: 1, deletions: 1 },
      { path: "assets/x.bin", binary: true, additions: undefined, deletions: undefined },
    ]);
  });

  it("drops a numstat rename the byte cap cut in half", () => {
    assert.deepEqual(parseNumstat("1\t1\t\u0000old.ts\u0000"), []);
  });

  it("parses commit metadata with a multi-line message", () => {
    const output =
      [sha1, "p".repeat(40), "Ana", "ana@example.com", "2026-01-02T03:04:05+01:00",
        "Ana", "ana@example.com", "2026-01-02T03:04:05+01:00",
        "Subject\n\nbody with \u001f inside\n"].join("\u001f");
    const parsed = parseCommitMetadata(output);
    assert.equal(parsed?.commit, sha1);
    assert.deepEqual(parsed?.parents, ["p".repeat(40)]);
    assert.equal(parsed?.author, "Ana");
    assert.equal(parsed?.message, "Subject\n\nbody with \u001f inside");
  });

  it("rejects metadata that is missing fields", () => {
    assert.equal(parseCommitMetadata("only\u001ftwo\u001ffields"), undefined);
  });
});

describe("history rendering", () => {
  const logResult: LogResult = {
    project: "demo",
    ref: "fix/TEST-1",
    commit: "a".repeat(40),
    path: "src/index.tsx",
    entries: [
      {
        commit: "a".repeat(40),
        short: "aaaaaaaaaaaa",
        parents: ["b".repeat(40), "c".repeat(40)],
        author: "Ana",
        date: "2026-01-02T03:04:05+01:00",
        subject: "change\twith tab",
        merge: true,
      },
    ],
    truncated: true,
    outputTruncated: false,
    fetched: false,
  };

  it("renders rows, the merge marker and a capped footer", () => {
    const text = formatLog(logResult);
    assert.match(text, /^<log project="demo" ref="fix\/TEST-1" commit="a{40}" path="src\/index\.tsx" count="1"/);
    assert.match(text, /\naaaaaaaaaaaa\t2026-01-02T03:04:05\+01:00\tAna\tchange with tab\t\(merge\)\n/);
    assert.match(text, /\[truncated: showing the most recent 1 commits/);
    assert.match(text, /truncated="true"/);
  });

  const baseCommit: CommitResult = {
    project: "demo",
    rev: "fix/TEST-1",
    commit: "a".repeat(40),
    parents: ["b".repeat(40)],
    author: "Ana",
    authorEmail: "ana@example.com",
    authoredAt: "2026-01-02T03:04:05+01:00",
    committer: "Ana",
    committerEmail: "ana@example.com",
    committedAt: "2026-01-02T03:04:05+01:00",
    message: "subject\n\nbody\n",
    merge: false,
    files: [
      { status: "M", path: "src/a.ts", additions: 2, deletions: 1, binary: false },
      { status: "R091", path: "src/new.ts", oldPath: "src/old.ts", additions: 1, deletions: 1, binary: false },
      { status: "A", path: "assets/logo.bin", binary: true },
    ],
    additions: 3,
    deletions: 2,
    patchTruncated: false,
    filesTruncated: false,
    fetched: false,
  };

  it("renders a commit, its files and its patch", () => {
    const text = formatCommit({ ...baseCommit, patch: "diff --git a/src/a.ts b/src/a.ts\n" });
    assert.match(text, /^<commit project="demo" rev="fix\/TEST-1" sha="a{40}" parents="b{40}"/);
    assert.match(text, /author="Ana <ana@example.com>"/);
    assert.match(text, /\nsubject\n\nbody\n\n/);
    assert.match(text, /\nM\tsrc\/a\.ts\t\+2 -1\n/);
    assert.match(text, /\nR091\tsrc\/old\.ts -> src\/new\.ts\t\+1 -1\n/);
    assert.match(text, /\nA\tassets\/logo\.bin\tbinary\n/);
    assert.match(text, /\ndiff --git a\/src\/a\.ts b\/src\/a\.ts\n/);
    assert.match(text, /patch="true"/);
  });

  it("explains a merge commit instead of an empty list", () => {
    const text = formatCommit({
      ...baseCommit,
      merge: true,
      parents: ["b".repeat(40), "c".repeat(40)],
      files: [],
      additions: 0,
      deletions: 0,
    });
    assert.match(text, /merge="true"/);
    assert.match(text, /files="0"/);
    assert.match(text, /merge commit: git shows no diff for a merge by default/);
    assert.match(text, /compare "b{12}" "a{12}"/);
  });

  it("marks a cut patch and a cut file list", () => {
    const text = formatCommit({
      ...baseCommit,
      patch: "diff --git a/src/a.ts b/src/a.ts\n",
      patchTruncated: true,
      filesTruncated: true,
    });
    assert.match(text, /patch_truncated="true"/);
    assert.match(text, /\[truncated: the file list was cut at the size limit\]/);
    assert.match(text, /\[truncated: the patch was cut at the byte limit\]/);
  });
});

describe("blame", () => {
  it("blames a file at a ref and states the commit", async () => {
    const result = await store.blame("demo", "src/index.tsx", { ref: "fix/TEST-1" });
    assert.equal(result.project, "demo");
    assert.equal(result.ref, "fix/TEST-1");
    assert.equal(result.path, "src/index.tsx");
    assert.equal(result.binary, false);
    assert.equal(result.fileLines, 1);
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0]?.commit, result.commit);
    assert.equal(result.groups[0]?.author, "Test");
    assert.match(result.groups[0]?.date ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    assert.equal(result.groups[0]?.lines[0]?.text, "export const hello = 'fix/TEST-1';");
    assert.equal(result.truncated, false);
  });

  it("groups consecutive lines from one commit into one row", async () => {
    const rename = await store.getCommit("demo", "feat/RENAME");
    const parent = rename.parents[0] ?? "";
    const result = await store.blame("demo", "src/many.ts", { ref: parent });
    assert.equal(result.groups.length, 1);
    assert.deepEqual(
      result.groups[0]?.lines.map((line) => line.line),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.equal(result.groups[0]?.boundary, false);
  });

  it("keeps metadata for a commit that reappears after another one", async () => {
    const result = await store.blame("demo", "src/renamed.ts", { ref: "feat/RENAME" });
    assert.equal(result.fileLines, 8);
    assert.equal(result.groups.length, 3);
    assert.deepEqual(
      result.groups.map((group) => group.lines.map((line) => line.line)),
      [[1, 2, 3, 4], [5], [6, 7, 8]],
    );
    assert.equal(result.groups[0]?.commit, result.groups[2]?.commit);
    // Porcelain prints the metadata block once per commit, so the last group
    // only has its author because the parser cached it.
    assert.equal(result.groups[2]?.author, "Test");
    assert.match(result.groups[2]?.date ?? "", /^\d{4}-\d{2}-\d{2}T/);
  });

  it("narrows to a line range and reports what came back", async () => {
    const result = await store.blame("demo", "src/renamed.ts", {
      ref: "feat/RENAME",
      lines: { from: 4, to: 6 },
    });
    assert.equal(result.lines?.from, 4);
    assert.equal(result.lines?.to, 6);
    assert.equal(result.lines?.availableFrom, 4);
    assert.equal(result.lines?.availableTo, 6);
    assert.equal(result.lines?.fileLines, 8);
    assert.deepEqual(
      result.groups.map((group) => group.lines.map((line) => line.line)),
      [[4], [5], [6]],
    );
  });

  it("clamps a range that runs past the end", async () => {
    const result = await store.blame("demo", "src/renamed.ts", {
      ref: "feat/RENAME",
      lines: { from: 6, to: 20 },
    });
    assert.equal(result.lines?.availableFrom, 6);
    assert.equal(result.lines?.availableTo, 8);
    assert.deepEqual(
      result.groups.map((group) => group.lines.map((line) => line.line)),
      [[6, 7, 8]],
    );
  });

  it("returns no groups, not an error, for a range entirely past the end", async () => {
    const result = await store.blame("demo", "src/renamed.ts", {
      ref: "feat/RENAME",
      lines: { from: 20, to: 25 },
    });
    assert.deepEqual(result.groups, []);
    assert.equal(result.lines?.availableFrom, undefined);
    assert.equal(result.fileLines, 8);
  });

  it("caps the lines it returns and says so", async () => {
    const result = await store.blame("demo", "src/many.ts", {
      ref: (await store.getCommit("demo", "feat/RENAME")).parents[0] ?? "",
      maxLines: 3,
    });
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0]?.lines.length, 3);
    assert.equal(result.truncated, true);
    assert.equal(result.outputTruncated, false);
  });

  it("reports a binary file instead of blaming it", async () => {
    const result = await store.blame("demo", "assets/logo.bin", { ref: "feat/BINARY" });
    assert.equal(result.binary, true);
    assert.deepEqual(result.groups, []);
  });

  it("reports a missing path and a missing ref as NotFoundError", async () => {
    await assert.rejects(
      store.blame("demo", "src/nope.ts", { ref: "fix/TEST-1" }),
      NotFoundError,
    );
    await assert.rejects(
      store.blame("demo", "src/index.tsx", { ref: "no/such-branch" }),
      NotFoundError,
    );
  });
});

describe("blame parsing and rendering", () => {
  const sha1 = "a".repeat(40);
  const sha2 = "b".repeat(40);

  it("formats a blame timestamp with the author's own offset", () => {
    assert.equal(blameDate(0, "+0000"), "1970-01-01T00:00:00+00:00");
    assert.equal(blameDate(0, "+0100"), "1970-01-01T01:00:00+01:00");
    assert.equal(blameDate(0, "-0530"), "1969-12-31T18:30:00-05:30");
    assert.equal(blameDate(undefined, "+0100"), undefined);
    assert.equal(blameDate(0, undefined), "1970-01-01T00:00:00.000Z");
  });

  const porcelain = [
    `${sha1} 1 1 2`,
    "author Ana",
    "author-mail <ana@example.com>",
    "author-time 1767323045",
    "author-tz +0100",
    "summary one",
    "boundary",
    "filename three.txt",
    "\talpha",
    `${sha1} 2 2`,
    "\tbeta",
    `${sha2} 3 3 1`,
    "author Bo",
    "author-mail <bo@example.com>",
    "author-time 1767323045",
    "author-tz +0100",
    "summary two",
    "filename three.txt",
    "\tgamma",
    `${sha1} 4 4 1`,
    "\tdelta",
  ].join("\n");

  it("groups lines and caches a commit's metadata across groups", () => {
    const groups = parseBlame(porcelain);
    assert.equal(groups.length, 3);
    assert.deepEqual(
      groups.map((group) => group.lines.map((line) => line.line)),
      [[1, 2], [3], [4]],
    );
    assert.equal(groups[0]?.author, "Ana");
    assert.equal(groups[0]?.authorEmail, "ana@example.com");
    assert.equal(groups[0]?.boundary, true);
    assert.equal(groups[1]?.author, "Bo");
    assert.equal(groups[2]?.commit, sha1);
    assert.equal(groups[2]?.author, "Ana", "metadata is cached per sha, not per group");
    assert.match(groups[2]?.date ?? "", /\+01:00$/);
  });

  it("parses a line spec, including an L prefix and a reversed range", () => {
    assert.deepEqual(parseLineSpec("118"), { from: 118, to: 118 });
    assert.deepEqual(parseLineSpec("L118-126"), { from: 118, to: 126 });
    assert.deepEqual(parseLineSpec("126-118"), { from: 118, to: 126 });
    assert.equal(parseLineSpec("0"), undefined);
    assert.equal(parseLineSpec("1-"), undefined);
    assert.equal(parseLineSpec("abc"), undefined);
  });

  const blameResult: BlameResult = {
    project: "demo",
    ref: "fix/TEST-1",
    commit: sha1,
    path: "src/renamed.ts",
    binary: false,
    groups: [
      {
        commit: sha1,
        author: "Ana",
        date: "2026-01-02T03:04:05+01:00",
        summary: "one",
        boundary: false,
        lines: [
          { line: 1, text: "\talpha" },
          { line: 2, text: "beta" },
        ],
      },
      {
        commit: sha2,
        author: "Bo",
        date: "2026-01-01T00:00:00+00:00",
        boundary: false,
        lines: [{ line: 3, text: "gamma" }],
      },
    ],
    fileLines: 8,
    maxLines: 500,
    truncated: false,
    outputTruncated: false,
    fetched: false,
  };

  it("renders groups, line ranges and flattened line text", () => {
    const text = formatBlame(blameResult);
    assert.match(
      text,
      /^<blame project="demo" ref="fix\/TEST-1" commit="a{40}" path="src\/renamed\.ts" file_lines="8" groups="2" count="3" max_lines="500"/,
    );
    assert.match(text, /\na{12}\tAna\t2026-01-02T03:04:05\+01:00\t1-2\n/);
    assert.match(text, /\n  1:  alpha\n  2: beta\n/);
    assert.match(text, /\nb{12}\tBo\t2026-01-01T00:00:00\+00:00\t3\n/);
  });

  it("explains a range past the end", () => {
    const text = formatBlame({
      ...blameResult,
      groups: [],
      lines: { from: 20, to: 25, fileLines: 8 },
    });
    assert.match(text, /\(no lines: the file has 8 lines, so 20-25 are past the end\)/);
  });

  it("marks a capped blame and a clamped range", () => {
    const text = formatBlame({
      ...blameResult,
      groups: [{ ...blameResult.groups[0]!, lines: blameResult.groups[0]!.lines.slice(0, 1) }],
      truncated: true,
      lines: { from: 1, to: 20, availableFrom: 1, availableTo: 8, fileLines: 8 },
    });
    assert.match(text, /truncated="true"/);
    assert.match(text, /\[truncated: showing the first 1 lines; raise "max_lines" for more\]/);
    assert.match(text, /\[lines 1-20 were asked for; the file has 8, so 1-8 came back\]/);
  });
});

describe("compare", () => {
  it("compares from the merge base by default and names it", async () => {
    const result = await store.compare("demo", "main", "fix/TEST-1");
    assert.equal(result.from, "main");
    assert.equal(result.to, "fix/TEST-1");
    assert.equal(result.mergeBaseRequested, true);
    assert.equal(result.mergeBaseMissing, false);
    assert.match(result.mergeBase ?? "", /^[0-9a-f]{40}$/);
    // main carries the merge commit; the branch split before it.
    assert.notEqual(result.mergeBase, result.fromCommit);
    assert.deepEqual(
      result.files.map((file) => `${file.status} ${file.path}`),
      ["A docs/readme.md", "A src/components/Button.tsx", "M src/index.tsx"],
    );
    assert.equal(result.totalFiles, 3);
    assert.equal(result.additions, 3);
    assert.equal(result.deletions, 1);
    assert.equal(result.truncated, false);
    assert.equal(result.outputTruncated, false);
    assert.ok(result.syncedAt instanceof Date);
  });

  it("differs in the two-dot direction when merge_base is false", async () => {
    const result = await store.compare("demo", "main", "fix/TEST-1", { mergeBase: false });
    assert.equal(result.mergeBase, undefined);
    assert.equal(result.mergeBaseRequested, false);
    assert.equal(result.mergeBaseMissing, false);
    assert.deepEqual(
      result.files.map((file) => `${file.status} ${file.path}`),
      ["A docs/readme.md", "A src/components/Button.tsx", "M src/index.tsx", "D src/merged.ts"],
    );
    assert.equal(result.deletions, 2);
  });

  it("reports a rename with both paths", async () => {
    const parent = (await store.getCommit("demo", "feat/RENAME")).parents[0] ?? "";
    const result = await store.compare("demo", parent, "feat/RENAME");
    assert.equal(result.mergeBase, parent);
    assert.equal(result.files.length, 1);
    const file = result.files[0];
    assert.match(file?.status ?? "", /^R\d+$/);
    assert.equal(file?.oldPath, "src/many.ts");
    assert.equal(file?.path, "src/renamed.ts");
    assert.equal(file?.additions, 1);
    assert.equal(file?.deletions, 1);
  });

  it("marks a binary file rather than counting its lines", async () => {
    const result = await store.compare("demo", "main", "feat/BINARY");
    assert.equal(result.files[0]?.path, "assets/logo.bin");
    assert.equal(result.files[0]?.binary, true);
    assert.equal(result.files[0]?.additions, undefined);
    assert.equal(result.additions, 0);
  });

  it("narrows the comparison to a pathspec", async () => {
    const result = await store.compare("demo", "main", "fix/TEST-1", { path: "docs/readme.md" });
    assert.deepEqual(
      result.files.map((file) => file.path),
      ["docs/readme.md"],
    );
    assert.equal(result.totalFiles, 1);
    assert.equal(result.path, "docs/readme.md");
  });

  it("caps the rows but keeps the totals over every file", async () => {
    const result = await store.compare("demo", "main", "fix/TEST-1", { maxFiles: 1 });
    assert.equal(result.files.length, 1);
    assert.equal(result.totalFiles, 3);
    assert.equal(result.additions, 3);
    assert.equal(result.deletions, 1);
    assert.equal(result.truncated, true);
    assert.equal(result.outputTruncated, false);
  });

  it("never takes a cap of zero", async () => {
    const result = await store.compare("demo", "main", "fix/TEST-1", { maxFiles: 0 });
    assert.equal(result.maxFiles, 1);
    assert.equal(result.files.length, 1);
  });

  it("falls back to the two-dot diff when the refs share no root", async () => {
    const result = await store.compare("demo", "main", "feat/ORPHAN");
    assert.equal(result.mergeBase, undefined);
    assert.equal(result.mergeBaseRequested, true);
    assert.equal(result.mergeBaseMissing, true);
    assert.deepEqual(
      result.files.map((file) => `${file.status} ${file.path}`),
      ["D src/index.tsx", "D src/merged.ts", "A src/orphan.ts"],
    );
  });

  it("answers an identical pair with no files", async () => {
    const result = await store.compare("demo", "fix/TEST-1", "fix/TEST-1");
    assert.deepEqual(result.files, []);
    assert.equal(result.totalFiles, 0);
    assert.equal(result.truncated, false);
  });

  it("names whichever ref is missing", async () => {
    await assert.rejects(store.compare("demo", "no/such", "main"), NotFoundError);
    await assert.rejects(store.compare("demo", "main", "no/such"), NotFoundError);
    const error = (await store.compare("demo", "main", "no/such").catch((thrown) => thrown)) as Error;
    assert.match(error.message, /"no\/such"/);
  });
});

describe("diff_file", () => {
  it("returns one file's patch, scoped by the path", async () => {
    const result = await store.diffFile("demo", "src/index.tsx", "main", "fix/TEST-1");
    assert.equal(result.path, "src/index.tsx");
    assert.equal(result.from, "main");
    assert.equal(result.to, "fix/TEST-1");
    assert.equal(result.context, 3);
    assert.equal(result.binary, false);
    assert.equal(result.truncated, false);
    assert.match(result.patch, /^diff --git a\/src\/index\.tsx b\/src\/index\.tsx\n/);
    assert.match(result.patch, /\n-export const hello = 'main';\n\+export const hello = 'fix\/TEST-1';\n$/);
  });

  it("honours the context width, and clamps it at ten", async () => {
    const parent = (await store.getCommit("demo", "feat/CTX")).parents[0] ?? "";
    const wide = await store.diffFile("demo", "src/context.ts", parent, "feat/CTX");
    const tight = await store.diffFile("demo", "src/context.ts", parent, "feat/CTX", { context: 0 });
    assert.equal(wide.context, 3);
    assert.equal(tight.context, 0);
    assert.match(wide.patch, /^ export const row4 = 4;$/m, "three lines of context are shown");
    assert.match(wide.patch, /^ export const row6 = 6;$/m);
    // At context 0 git still names the nearest preceding line in the hunk
    // header (`@@ -5 +5 @@ export const row4 = 4;`, measured), but it is not a
    // context line: no line of the patch starts with a space.
    assert.doesNotMatch(tight.patch, /^ export const row4 = 4;$/m);
    assert.match(tight.patch, /^@@ -5 \+5 @@/m);
    assert.match(tight.patch, /^-export const row5 = 5;$/m);
    assert.match(tight.patch, /^\+export const row5 = 'edited';$/m);

    const clamped = await store.diffFile("demo", "src/index.tsx", "main", "fix/TEST-1", {
      context: 99,
    });
    assert.equal(clamped.context, 10);
  });

  it("answers a path that did not change with an empty patch", async () => {
    const result = await store.diffFile("demo", "src/index.tsx", "main", "main");
    assert.equal(result.patch, "");
    assert.equal(result.binary, false);
  });

  it("reports a binary file instead of a patch", async () => {
    const result = await store.diffFile("demo", "assets/logo.bin", "main", "feat/BINARY");
    assert.equal(result.binary, true);
    assert.equal(result.patch, "");
  });

  it("cuts the patch at the byte cap and says so", async () => {
    const result = await store.diffFile("demo", "src/index.tsx", "main", "fix/TEST-1", {
      maxBytes: 60,
    });
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.patch, "utf8") <= 60);
  });

  it("reads a rename through its new name as an add, because the path scopes the diff", async () => {
    const parent = (await store.getCommit("demo", "feat/RENAME")).parents[0] ?? "";
    const result = await store.diffFile("demo", "src/renamed.ts", parent, "feat/RENAME");
    assert.match(result.patch, /^new file mode 100644$/m);
    assert.doesNotMatch(result.patch, /^rename from /m);
  });

  it("reports a path absent from both refs, and a missing ref", async () => {
    await assert.rejects(
      store.diffFile("demo", "src/nope.ts", "main", "fix/TEST-1"),
      NotFoundError,
    );
    await assert.rejects(store.diffFile("demo", "src/index.tsx", "main", "no/such"), NotFoundError);
  });
});

describe("compare and diff_file rendering", () => {
  const baseCompare: CompareResult = {
    project: "demo",
    from: "main",
    to: "fix/TEST-1",
    fromCommit: "a".repeat(40),
    toCommit: "b".repeat(40),
    mergeBase: "c".repeat(40),
    mergeBaseRequested: true,
    mergeBaseMissing: false,
    files: [
      { status: "M", path: "src/index.tsx", additions: 1, deletions: 1, binary: false },
      {
        status: "R084",
        path: "src/renamed.ts",
        oldPath: "src/many.ts",
        additions: 1,
        deletions: 1,
        binary: false,
      },
      { status: "A", path: "assets/logo.bin", binary: true },
    ],
    totalFiles: 3,
    additions: 2,
    deletions: 2,
    maxFiles: 100,
    truncated: false,
    outputTruncated: false,
    fetched: false,
  };

  it("renders the summary, the base and each row", () => {
    const text = formatCompare(baseCompare);
    assert.match(
      text,
      /^<compare project="demo" from="main" to="fix\/TEST-1" from_commit="a{40}" to_commit="b{40}" merge_base="c{40}" files="3" total_files="3" additions="2" deletions="2" max_files="100"/,
    );
    assert.match(text, /\nM\tsrc\/index\.tsx\t\+1 -1\n/);
    assert.match(text, /\nR084\tsrc\/many\.ts -> src\/renamed\.ts\t\+1 -1\n/);
    assert.match(text, /\nA\tassets\/logo\.bin\tbinary\n/);
  });

  it("tells a two-dot diff from one with no merge base", () => {
    const twoDot = formatCompare({
      ...baseCompare,
      mergeBase: undefined,
      mergeBaseRequested: false,
    });
    assert.match(twoDot, /merge_base="off"/);
    assert.doesNotMatch(twoDot, /no merge base/);

    const unrelated = formatCompare({ ...baseCompare, mergeBase: undefined, mergeBaseMissing: true });
    assert.match(unrelated, /merge_base="none"/);
    assert.match(
      unrelated,
      /\[no merge base: "main" and "fix\/TEST-1" have unrelated histories, so this is a raw two-dot diff between the two commits\]/,
    );
  });

  it("marks a capped list and a narrowed path", () => {
    const text = formatCompare({
      ...baseCompare,
      files: [baseCompare.files[0]!],
      truncated: true,
      path: "src",
    });
    assert.match(text, /truncated="true"/);
    assert.match(
      text,
      /\[truncated: showing the first 1 of 3 changed files; raise "max_files" for more\]/,
    );
    assert.match(text, /path="src"/);
    assert.match(text, /\[path is a git pathspec, and it narrows rename detection with it/);
  });

  const diffResult: DiffFileResult = {
    project: "demo",
    path: "src/index.tsx",
    from: "main",
    to: "fix/TEST-1",
    fromCommit: "a".repeat(40),
    toCommit: "b".repeat(40),
    context: 3,
    binary: false,
    patch: "diff --git a/src/index.tsx b/src/index.tsx\n@@ -1 +1 @@\n-old\n+new\n",
    truncated: false,
    fetched: false,
  };

  it("renders the patch verbatim under its header", () => {
    const text = formatDiffFile(diffResult);
    assert.match(
      text,
      /^<diff project="demo" path="src\/index\.tsx" from="main" to="fix\/TEST-1" from_commit="a{40}" to_commit="b{40}" context="3" bytes="\d+"/,
    );
    assert.match(text, /\n@@ -1 \+1 @@\n-old\n\+new\n<\/diff>$/);
  });

  it("says so when there is nothing to show, and when the patch was cut", () => {
    const empty = formatDiffFile({ ...diffResult, patch: "" });
    assert.match(empty, /\(no changes to "src\/index\.tsx" between "main" and "fix\/TEST-1"\)/);

    const cut = formatDiffFile({ ...diffResult, patch: "diff --git a/x b/x\n", truncated: true });
    assert.match(cut, /truncated="true"/);
    assert.match(cut, /\[truncated: the patch was cut at the byte limit\]/);
  });
});
