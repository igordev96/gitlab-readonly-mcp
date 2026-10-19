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
  parseCommitMetadata,
  parseLogEntries,
  parseNameStatus,
  parseNumstat,
  type CommitResult,
  type LogResult,
} from "../src/repoStore.js";
import { formatCommit, formatLog } from "../src/tools/history.js";
import { addBranchWithFile, addMergedBranch, buildFixture, renameOnBranch } from "./fixture.js";

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
