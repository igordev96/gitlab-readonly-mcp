// Search layer: `git grep` and `git log -S`, their parsers, and their renderers.
// Runs offline against a fixture "GitLab" built in the temp directory.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Config } from "../src/config.js";
import { Git } from "../src/git.js";
import {
  NotFoundError,
  RepoStore,
  contextLines,
  contextRanges,
  parseGrepCounts,
  parseGrepMatches,
  parseGrepPaths,
  parsePickaxeEntries,
  type PickaxeResult,
  type SearchResult,
} from "../src/repoStore.js";
import { formatPickaxe, formatSearch, matchLine } from "../src/tools/search.js";
import {
  addBranchWithFile,
  buildFixture,
  commitOnBranch,
  publishBranchFromElsewhere,
} from "./fixture.js";

const fixture = buildFixture(path.join(os.tmpdir(), "glmcp-fixture-search"));

/** A file worth putting context around: a run of matches, a gap, and the last line. */
const CONTEXT_FILE =
  [
    "header",
    "alpha one",
    "alpha two",
    "middle one",
    "body five",
    "body six",
    "body seven",
    "body eight",
    "body nine",
    "alpha three",
    "body eleven",
    "body twelve",
    "body thirteen",
    "body fourteen",
    "alpha last",
  ].join("\n") + "\n";

addBranchWithFile(fixture.work, "feat/CONTEXT", "ctx.txt", CONTEXT_FILE, "context fixture");

/**
 * Publish `count` files that all match, in one commit.
 *
 * One commit rather than one per file: the point is the context file budget, and
 * twenty-one pushes would only slow the suite down.
 */
function publishMany(work: string, branch: string, count: number): void {
  execFileSync("git", ["-C", work, "checkout", "-q", "-B", branch], { stdio: "ignore" });
  for (let index = 0; index < count; index += 1) {
    const target = path.join(work, "many", `f${index}.txt`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "manyMarker\n");
  }
  execFileSync("git", ["-C", work, "add", "-A"], { stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-C",
      work,
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "-q",
      "-m",
      "many files",
    ],
    { stdio: "ignore" },
  );
  execFileSync("git", ["-C", work, "push", "-q", "origin", branch], { stdio: "ignore" });
  execFileSync("git", ["-C", work, "checkout", "-q", "main"], { stdio: "ignore" });
}

publishMany(fixture.work, "feat/MANY", 21);

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: pathToFileURL(fixture.root).href,
    token: "",
    cacheDir: path.join(fixture.root, "cache"),
    gitBin: "git",
    fetchMode: "ttl",
    fetchTtlSeconds: 600,
    ...overrides,
  };
}

const store = new RepoStore(makeConfig(), new Git({ bin: "git" }));

describe("parseGrepMatches", () => {
  it("reads the fields -z separates, and the newline git still writes after each match", () => {
    // Exactly what `git grep --line-number -z` produced under git 2.53: the
    // path/line/text fields are NUL-separated, but the next record's path is
    // joined to the previous record's text by a newline rather than a NUL.
    const rev = "a".repeat(40);
    const output =
      `${rev}:src/a.ts\u000012\u0000const x = 1;\n` + `${rev}:src/b.ts\u00003\u0000const x = 2;\n`;

    assert.deepEqual(parseGrepMatches(output, rev), [
      { path: "src/a.ts", line: 12, text: "const x = 1;" },
      { path: "src/b.ts", line: 3, text: "const x = 2;" },
    ]);
  });

  it("keeps a path containing a newline as one match", () => {
    // The reason `-z` exists. The text is one line by definition, so the *first*
    // newline in the token is the join and the path after it may contain more.
    const rev = "b".repeat(40);
    const output = `${rev}:we\nird.txt\u00007\u0000matched line\n`;

    const matches = parseGrepMatches(output, rev);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.path, "we\nird.txt");
    assert.equal(matches[0]?.text, "matched line");
  });

  it("strips the revision prefix by exact match, so a colon in a path survives", () => {
    const rev = "c".repeat(40);
    const output = `${rev}:src/odd:name.ts\u00001\u0000text\n`;
    assert.equal(parseGrepMatches(output, rev)[0]?.path, "src/odd:name.ts");
  });

  it("drops a record torn by the byte cap instead of guessing at it", () => {
    const rev = "d".repeat(40);
    const output = `${rev}:src/a.ts\u000012\u0000complete\n${rev}:src/b.ts\u00001`;

    assert.deepEqual(parseGrepMatches(output, rev), [
      { path: "src/a.ts", line: 12, text: "complete" },
    ]);
  });

  it("strips a carriage return from a CRLF line, and handles no matches", () => {
    const rev = "e".repeat(40);
    assert.equal(parseGrepMatches(`${rev}:a.ts\u00001\u0000windows\r\n`, rev)[0]?.text, "windows");
    assert.deepEqual(parseGrepMatches("", rev), []);
  });
});

describe("parseGrepPaths", () => {
  it("reads -l output, which is NUL-separated and has no newline at all", () => {
    // Exactly what `git grep -l -z` produced under git 2.53: separated by NUL,
    // ending with one, and with no newline anywhere — unlike a match record.
    const rev = "a".repeat(40);
    const output = `${rev}:src/a.ts\u0000${rev}:src/b.ts\u0000`;

    assert.deepEqual(parseGrepPaths(output, rev), ["src/a.ts", "src/b.ts"]);
  });

  it("keeps a path containing a newline, which is the whole point of -z", () => {
    const rev = "b".repeat(40);
    assert.deepEqual(parseGrepPaths(`${rev}:we\nird.txt\u0000`, rev), ["we\nird.txt"]);
  });

  it("drops a final path the byte cap cut in half, because it lacks its NUL", () => {
    const rev = "c".repeat(40);
    const output = `${rev}:src/a.ts\u0000${rev}:src/incompl`;

    assert.deepEqual(parseGrepPaths(output, rev), ["src/a.ts"]);
  });

  it("handles no matches, and ignores a field without the revision prefix", () => {
    const rev = "d".repeat(40);
    assert.deepEqual(parseGrepPaths("", rev), []);
    assert.deepEqual(parseGrepPaths(`other:src/a.ts\u0000`, rev), []);
  });
});

describe("parseGrepCounts", () => {
  it("reads --count output, which is a pair per file like the match layout", () => {
    // Exactly what `git grep --count -z` produced: `rev:path \0 count \n`, the
    // count standing where a match's line number stands, and no text.
    const rev = "a".repeat(40);
    const output = `${rev}:src/a.ts\u00003\n${rev}:src/b.ts\u00001\n`;

    assert.deepEqual(parseGrepCounts(output, rev), [
      { path: "src/a.ts", count: 3 },
      { path: "src/b.ts", count: 1 },
    ]);
  });

  it("keeps a path containing a newline, and counts the file after it correctly", () => {
    const rev = "b".repeat(40);
    const output = `${rev}:we\nird.txt\u00007\n${rev}:src/b.ts\u00002\n`;

    assert.deepEqual(parseGrepCounts(output, rev), [
      { path: "we\nird.txt", count: 7 },
      { path: "src/b.ts", count: 2 },
    ]);
  });

  it("drops a zero, which -c prints for a pathspec that named a file with no match", () => {
    const rev = "c".repeat(40);
    const output = `${rev}:src/a.ts\u00000\n${rev}:src/b.ts\u00002\n`;

    assert.deepEqual(parseGrepCounts(output, rev), [{ path: "src/b.ts", count: 2 }]);
  });

  it("handles no matches, and a count torn away by the byte cap", () => {
    const rev = "d".repeat(40);
    assert.deepEqual(parseGrepCounts("", rev), []);
    assert.deepEqual(parseGrepCounts(`${rev}:src/a.ts\u0000`, rev), []);
  });
});

describe("contextRanges", () => {
  it("merges windows that touch, and keeps distant ones apart", () => {
    assert.deepEqual(contextRanges([2, 3, 10, 15], 1, 15), [
      { from: 1, to: 4 },
      { from: 9, to: 11 },
      { from: 14, to: 15 },
    ]);
  });

  it("joins windows that overlap", () => {
    // Radius 2 puts 8..12 and 11..15 on top of each other; one hunk, not two.
    assert.deepEqual(contextRanges([10, 13], 2, 20), [{ from: 8, to: 15 }]);
  });

  it("clamps to the file, so the first and last lines have no phantom neighbour", () => {
    assert.deepEqual(contextRanges([1], 3, 5), [{ from: 1, to: 4 }]);
    assert.deepEqual(contextRanges([5], 3, 5), [{ from: 2, to: 5 }]);
  });

  it("answers nothing for no matches, and drops a line past the file", () => {
    assert.deepEqual(contextRanges([], 2, 10), []);
    assert.deepEqual(contextRanges([40], 2, 10), []);
  });
});

describe("contextLines", () => {
  it("numbers the merged ranges and marks only the matched lines", () => {
    assert.deepEqual(contextLines("one\ntwo\nthree\nfour\nfive\n", [2, 4], 1), [
      { line: 1, text: "one", matched: false },
      { line: 2, text: "two", matched: true },
      { line: 3, text: "three", matched: false },
      { line: 4, text: "four", matched: true },
      { line: 5, text: "five", matched: false },
    ]);
  });

  it("drops a CR so a CRLF file reads like the match rows do", () => {
    assert.deepEqual(contextLines("one\r\ntwo\r\n", [1], 1), [
      { line: 1, text: "one", matched: true },
      { line: 2, text: "two", matched: false },
    ]);
  });

  it("keeps a final line with no newline, and handles an empty file", () => {
    assert.deepEqual(contextLines("only", [1], 1), [{ line: 1, text: "only", matched: true }]);
    assert.deepEqual(contextLines("", [], 1), []);
  });
});

describe("matchLine", () => {
  it("flattens tabs and trailing space", () => {
    assert.equal(matchLine("\tconst\tx = 1;\t \r"), " const x = 1;");
  });

  it("cuts a long line and says how much was cut", () => {
    const rendered = matchLine("x".repeat(400));
    assert.equal(rendered.length, 300 + "… [+100 characters]".length);
    assert.match(rendered, /^x{300}… \[\+\d+ characters\]$/);
    assert.match(rendered, /\[\+100 characters\]$/);
  });
});

function searchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    project: "demo",
    ref: "main",
    commit: "a".repeat(40),
    query: "hello",
    regex: false,
    caseSensitive: false,
    output: "matches",
    matches: [],
    fileHits: [],
    total: 0,
    files: 0,
    truncated: false,
    outputTruncated: false,
    fetched: false,
    ...overrides,
  };
}

describe("formatSearch", () => {
  it("groups matches under their file, with provenance", () => {
    const text = formatSearch(
      searchResult({
        syncedAt: new Date("2026-10-18T09:00:00.000Z"),
        matches: [
          { path: "src/a.ts", line: 1, text: "const hello = 1;" },
          { path: "src/a.ts", line: 9, text: 'log("hello")' },
          { path: "src/b.tsx", line: 4, text: "{hello}" },
        ],
        total: 3,
        files: 2,
      }),
    );

    assert.match(text, /^<search project="demo" ref="main" commit="a{40}" query="hello"/);
    assert.match(text, /count="3" files="2" synced_at="2026-10-18T09:00:00.000Z"/);
    assert.match(
      text,
      /\nsrc\/a\.ts\n {2}1: const hello = 1;\n {2}9: log\("hello"\)\nsrc\/b\.tsx\n {2}4: \{hello\}\n<\/search>$/,
    );
  });

  it("says so when nothing matched, and when the age is unknown", () => {
    const text = formatSearch(searchResult());
    assert.match(text, /count="0" files="0" synced_at="unknown"/);
    assert.match(text, /\(no matches\)/);
  });

  it("reports the true total when the cap hid matches", () => {
    const text = formatSearch(
      searchResult({
        matches: [{ path: "a.ts", line: 1, text: "one" }],
        total: 42,
        files: 9,
        truncated: true,
      }),
    );
    // `files` counts every match found, not the returned slice: reporting the
    // slice's file count here would say "42 matches in 1 file", which is a
    // claim about the repository that the answer does not support.
    assert.match(text, /count="1" total="42" files="9"/);
    assert.match(text, /\[truncated: showing 1 of 42 matches\]/);
  });

  it("admits when the output itself was cut, rather than reporting a count as final", () => {
    const text = formatSearch(
      searchResult({
        matches: [{ path: "a.ts", line: 1, text: "one" }],
        total: 1,
        files: 1,
        truncated: true,
        outputTruncated: true,
      }),
    );
    assert.match(text, /\[truncated: the search output was cut at the size limit/);
    assert.match(text, /every count here is a lower bound/);
  });

  it("carries the flags that changed the match, and a failed refresh", () => {
    const text = formatSearch(
      searchResult({
        regex: true,
        caseSensitive: true,
        path: "src",
        refreshError: "token rejected",
      }),
    );
    assert.match(text, /regex="true" case_sensitive="true" path="src"/);
    assert.match(text, /refresh_failed="true"/);
    assert.match(text, /\[refresh failed: token rejected\]/);
  });

  it("renders files mode as one path per row, with no match lines", () => {
    const text = formatSearch(
      searchResult({
        output: "files",
        fileHits: [{ path: "src/a.ts" }, { path: "src/b.tsx" }],
        total: undefined,
        files: 2,
      }),
    );

    assert.match(text, /output="files"/);
    assert.match(text, /count="2" files="2"/);
    assert.doesNotMatch(text, /total="/);
    assert.match(text, /\nsrc\/a\.ts\nsrc\/b\.tsx\n<\/search>$/);
  });

  it("renders count mode as path and count, with the exact total", () => {
    const text = formatSearch(
      searchResult({
        output: "count",
        fileHits: [
          { path: "src/a.ts", count: 3 },
          { path: "src/b.tsx", count: 1 },
        ],
        total: 4,
        files: 2,
      }),
    );

    assert.match(text, /output="count"/);
    assert.match(text, /count="2"/);
    assert.match(text, /files="2"/);
    assert.match(text, /\nsrc\/a\.ts\t3\nsrc\/b\.tsx\t1\n<\/search>$/);
  });

  it("says a capped files list is a capped list, and that the total still counts", () => {
    const files = formatSearch(
      searchResult({
        output: "files",
        fileHits: [{ path: "src/a.ts" }],
        total: undefined,
        files: 9,
        truncated: true,
      }),
    );
    assert.match(files, /count="1" files="9"/);
    assert.match(files, /\[truncated: showing 1 of 9 files\]/);

    const counts = formatSearch(
      searchResult({
        output: "count",
        fileHits: [{ path: "src/a.ts", count: 3 }],
        total: 42,
        files: 9,
        truncated: true,
      }),
    );
    assert.match(counts, /count="1" total="42" files="9"/);
    assert.match(counts, /\[truncated: showing 1 of 9 files; total counts every match\]/);
  });

  it("reports no matches the same way in every mode", () => {
    for (const output of ["matches", "files", "count"] as const) {
      const text = formatSearch(searchResult({ output, total: undefined, files: 0 }));
      assert.match(text, /count="0" files="0"/);
      assert.match(text, /\(no matches\)/);
    }
  });

  it("renders context as a numbered hunk, marking matches and breaking distant ones", () => {
    const text = formatSearch(
      searchResult({
        context: {
          radius: 1,
          files: [
            {
              path: "src/a.ts",
              lines: [
                { line: 1, text: "header", matched: false },
                { line: 2, text: "alpha one", matched: true },
                { line: 3, text: "tail", matched: false },
                { line: 9, text: "alpha two", matched: true },
              ],
            },
          ],
        },
        matches: [
          { path: "src/a.ts", line: 2, text: "alpha one" },
          { path: "src/a.ts", line: 9, text: "alpha two" },
        ],
        total: 2,
        files: 1,
      }),
    );

    assert.match(text, /context="1"/);
    assert.match(
      text,
      /\nsrc\/a\.ts\n {2}1: header\n> 2: alpha one\n {2}3: tail\n {2}…\n> 9: alpha two\n/,
    );
  });

  it("falls back to the match rows when a file has no context, and says why", () => {
    const text = formatSearch(
      searchResult({
        context: {
          radius: 1,
          files: [{ path: "src/a.ts", lines: [], note: "the file is binary" }],
        },
        matches: [{ path: "src/a.ts", line: 4, text: "alpha" }],
        total: 1,
        files: 1,
      }),
    );

    assert.match(text, /\nsrc\/a\.ts\n {2}4: alpha\n {2}\[no context: the file is binary\]\n/);
  });
});

describe("parsePickaxeEntries", () => {
  it("reads a row, keeping a subject that contains a tab", () => {
    const output = "abc1234\t2026-10-18\tIgor\tadd\tsomething\n";
    assert.deepEqual(parsePickaxeEntries(output), [
      { commit: "abc1234", date: "2026-10-18", author: "Igor", subject: "add\tsomething" },
    ]);
    assert.deepEqual(parsePickaxeEntries(""), []);
  });
});

function pickaxeResult(overrides: Partial<PickaxeResult> = {}): PickaxeResult {
  return {
    project: "demo",
    ref: "main",
    commit: "a".repeat(40),
    query: "hello",
    caseSensitive: false,
    entries: [],
    truncated: false,
    outputTruncated: false,
    fetched: false,
    ...overrides,
  };
}

describe("formatPickaxe", () => {
  it("renders one commit per row, and says when there is nothing", () => {
    const rows = formatPickaxe(
      pickaxeResult({
        entries: [{ commit: "abc1234def", date: "2026-10-18", author: "Igor", subject: "add it" }],
        syncedAt: new Date("2026-10-18T09:00:00.000Z"),
      }),
    );
    assert.match(
      rows,
      /^<pickaxe project="demo" ref="main" commit="a{40}" query="hello" count="1"/,
    );
    assert.match(rows, /\nabc1234def\t2026-10-18\tIgor\tadd it\n<\/pickaxe>$/);

    const empty = formatPickaxe(pickaxeResult());
    assert.match(empty, /\(no commits changed how often this appears\)/);
  });

  it("marks a truncated history walk and names the knob", () => {
    const text = formatPickaxe(
      pickaxeResult({
        entries: [{ commit: "abc1234", date: "2026-10-18", author: "Igor", subject: "add it" }],
        truncated: true,
        caseSensitive: true,
      }),
    );
    assert.match(text, /truncated="true"/);
    assert.match(text, /case_sensitive="true"/);
    assert.match(
      text,
      /\[truncated: showing the most recent 1 commits; raise "limit" for older ones\]/,
    );
  });

  it("does not tell the reader to raise a limit that was not the cause", () => {
    // The byte cap cut the walk, so more `limit` would return more of the same
    // truncated stream; naming it as the cause would send the reader the wrong way.
    const text = formatPickaxe(pickaxeResult({ truncated: true, outputTruncated: true }));
    assert.match(text, /truncated="true"/);
    assert.match(text, /\[truncated: the history output was cut at the size limit/);
    assert.doesNotMatch(text, /raise "limit"/);
  });
});

describe("search over a fixture", () => {
  it("finds a string on a branch that is not checked out, and not on the other branch", async () => {
    const onBranch = await store.search("demo", "fix/TEST-1", { ref: "fix/TEST-1" });
    assert.equal(onBranch.total, 1);
    assert.equal(onBranch.matches[0]?.path, "src/index.tsx");
    assert.equal(onBranch.matches[0]?.line, 1);
    assert.match(onBranch.matches[0]?.text ?? "", /export const hello/);
    assert.equal(onBranch.ref, "fix/TEST-1");

    const onMain = await store.search("demo", "fix/TEST-1", { ref: "main" });
    assert.equal(onMain.total, 0);
    assert.deepEqual(onMain.matches, []);
    assert.equal(onMain.truncated, false);
  });

  it("defaults to the default branch when no ref is given", async () => {
    const result = await store.search("demo", "export const hello");
    assert.equal(result.ref, "main");
    assert.equal(result.total, 1);
  });

  it("groups several files in one answer", async () => {
    const result = await store.search("demo", "export const", { ref: "fix/TEST-1" });
    const files = new Set(result.matches.map((match) => match.path));
    assert.deepEqual([...files].sort(), ["src/components/Button.tsx", "src/index.tsx"]);
  });

  it("matches case-insensitively by default, and exactly when asked", async () => {
    const loose = await store.search("demo", "BUTTON", { ref: "fix/TEST-1" });
    assert.equal(loose.total, 1);
    assert.equal(loose.caseSensitive, false);

    const exact = await store.search("demo", "BUTTON", { ref: "fix/TEST-1", caseSensitive: true });
    assert.equal(exact.total, 0);
    assert.equal(exact.caseSensitive, true);
  });

  it("treats the query literally by default, and as ERE when asked", async () => {
    // `Button|hello` is a BRE/ERE alternation, not a literal: defaulting to
    // literal keeps a caller's `foo|bar` from silently matching nothing.
    const literal = await store.search("demo", "Button|hello", { ref: "fix/TEST-1" });
    assert.equal(literal.total, 0);

    const regex = await store.search("demo", "Button|hello", { ref: "fix/TEST-1", regex: true });
    assert.equal(regex.total, 2);
    assert.equal(regex.regex, true);
  });

  it("limits the search to a pathspec, including a glob", async () => {
    const dir = await store.search("demo", "export const", {
      ref: "fix/TEST-1",
      path: "src/components",
    });
    assert.deepEqual(
      dir.matches.map((match) => match.path),
      ["src/components/Button.tsx"],
    );

    const oneLevel = await store.search("demo", "export const", {
      ref: "fix/TEST-1",
      path: "src/components/*.tsx",
    });
    assert.deepEqual(
      oneLevel.matches.map((match) => match.path),
      ["src/components/Button.tsx"],
    );

    // A plain pathspec's `**` needs at least one directory level, so this misses
    // `src/index.tsx`; `:(glob)` is what makes `**` match zero or more, and the
    // tool passes the pathspec through as git defines it rather than inventing a
    // dialect. Both behaviours are pinned here so the description cannot drift.
    const starstar = await store.search("demo", "export const", {
      ref: "fix/TEST-1",
      path: "src/**/*.tsx",
    });
    assert.deepEqual(
      starstar.matches.map((match) => match.path),
      ["src/components/Button.tsx"],
    );

    const globMagic = await store.search("demo", "export const", {
      ref: "fix/TEST-1",
      path: ":(glob)src/**/*.tsx",
    });
    assert.equal(globMagic.total, 2);

    const nothing = await store.search("demo", "export const", {
      ref: "fix/TEST-1",
      path: "no/such/dir",
    });
    assert.equal(nothing.total, 0);
  });

  it("accepts a query that starts with a dash", async () => {
    commitOnBranch(
      fixture.work,
      "main",
      "src/flags.ts",
      "run('--dry-run');\n",
      "add a dashed flag",
    );
    await store.syncRepo("demo");

    const result = await store.search("demo", "--dry-run");
    assert.equal(result.total, 1);
    assert.equal(result.matches[0]?.path, "src/flags.ts");
  });

  it("caps the matches and reports the true total", async () => {
    const result = await store.search("demo", "export const", { ref: "fix/TEST-1", maxMatches: 1 });
    assert.equal(result.matches.length, 1);
    assert.equal(result.total, 2);
    // Both files are counted even though only one match is returned: `files`
    // describes the search, not the slice of it that fits in the answer.
    assert.equal(result.files, 2);
    assert.equal(result.truncated, true);
    assert.equal(result.outputTruncated, false);
  });

  it("reports a missing ref as not found, with close matches", async () => {
    await assert.rejects(
      () => store.search("demo", "hello", { ref: "fix/TEST-" }),
      (error: unknown) => {
        assert.ok(error instanceof NotFoundError);
        assert.match(error.message, /fix\/TEST-1/);
        return true;
      },
    );
  });

  it("fetches on the miss, so a branch published from elsewhere is searchable", async () => {
    // A ref that does not resolve is detectably missing, so search can fetch and
    // retry — the same trick `get_file` uses, which `list_refs` cannot.
    publishBranchFromElsewhere(fixture.server, "feat/LATE", "late.txt", "lateMarker\n");

    const result = await store.search("demo", "lateMarker", { ref: "feat/LATE" });
    assert.equal(result.total, 1);
    assert.equal(result.matches[0]?.path, "late.txt");
  });

  it("searches a registered clone, including a branch only its remote has", async () => {
    const clone = path.join(fixture.root, "local-clone");
    execFileSync("git", ["clone", "-q", fixture.server, clone], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Published after the clone was made, so the clone holds it only as
    // `refs/remotes/origin/…` and the read has to fetch to find it.
    publishBranchFromElsewhere(
      fixture.server,
      "feat/REMOTE-ONLY",
      "remote.txt",
      "remoteOnlyMarker\n",
    );

    await store.addRepo("demo", clone);
    try {
      const result = await store.search("demo", "remoteOnlyMarker", { ref: "feat/REMOTE-ONLY" });
      assert.equal(result.total, 1);
      assert.equal(result.ref, "feat/REMOTE-ONLY");
      assert.equal(result.matches[0]?.path, "remote.txt");
    } finally {
      await store.removeRepo("demo");
    }
  });
});

describe("search output modes over a fixture", () => {
  it("answers files and count without a matched line, and agrees with matches", async () => {
    const matchesMode = await store.search("demo", "export const", { ref: "fix/TEST-1" });
    const filesMode = await store.search("demo", "export const", {
      ref: "fix/TEST-1",
      output: "files",
    });
    const countMode = await store.search("demo", "export const", {
      ref: "fix/TEST-1",
      output: "count",
    });

    assert.equal(matchesMode.output, "matches");
    assert.equal(filesMode.output, "files");
    assert.equal(countMode.output, "count");
    assert.equal(filesMode.total, undefined, "files mode never asks git to count matches");

    // The three are three views of one answer, so they have to line up.
    assert.deepEqual(
      filesMode.fileHits.map((hit) => hit.path),
      countMode.fileHits.map((hit) => hit.path),
    );
    assert.equal(filesMode.files, matchesMode.files);
    assert.equal(countMode.files, matchesMode.files);
    assert.equal(countMode.total, matchesMode.total);
    assert.equal(
      countMode.fileHits.reduce((sum, hit) => sum + (hit.count ?? 0), 0),
      matchesMode.total,
      "-c counts matching lines, which is what a match list shows one row per",
    );
    assert.deepEqual(
      matchesMode.matches.map((match) => match.path),
      ["src/components/Button.tsx", "src/index.tsx"],
    );
  });

  it("caps the rows it shows while the totals stay exact", async () => {
    const full = await store.search("demo", "export const", { ref: "fix/TEST-1", output: "count" });
    const capped = await store.search("demo", "export const", {
      ref: "fix/TEST-1",
      output: "count",
      maxMatches: 1,
    });

    assert.equal(capped.fileHits.length, 1);
    assert.equal(capped.files, full.files, "the cap trims the rows, not the count of files");
    assert.equal(capped.total, full.total, "nor the count of matches");
    assert.equal(capped.truncated, true);
    assert.equal(capped.outputTruncated, false);

    const cappedFiles = await store.search("demo", "export const", {
      ref: "fix/TEST-1",
      output: "files",
      maxMatches: 1,
    });
    assert.equal(cappedFiles.fileHits.length, 1);
    assert.equal(cappedFiles.files, full.files);
    assert.equal(cappedFiles.truncated, true);
  });

  it("returns nothing, and no invented total, when the cheap modes find nothing", async () => {
    const files = await store.search("demo", "zzz_nothing_here_zzz", {
      ref: "fix/TEST-1",
      output: "files",
    });
    assert.deepEqual(files.fileHits, []);
    assert.equal(files.files, 0);
    assert.equal(files.total, undefined);
    assert.equal(files.truncated, false);

    const counts = await store.search("demo", "zzz_nothing_here_zzz", {
      ref: "fix/TEST-1",
      output: "count",
    });
    assert.deepEqual(counts.fileHits, []);
    assert.equal(counts.total, 0);
  });
});

describe("match context over a fixture", () => {
  it("shows the lines around each match, merged, with the matched ones marked", async () => {
    const result = await store.search("demo", "alpha", { ref: "feat/CONTEXT", context: 1 });
    assert.equal(result.context?.radius, 1);

    const file = result.context?.files.find((entry) => entry.path === "ctx.txt");
    assert.deepEqual(
      file?.lines.map((line) => line.line),
      [1, 2, 3, 4, 9, 10, 11, 14, 15],
    );
    assert.deepEqual(
      file?.lines.filter((line) => line.matched).map((line) => line.line),
      [2, 3, 10, 15],
    );
    assert.equal(file?.note, undefined);
  });

  it("widens with the radius, and joins windows that meet", async () => {
    const result = await store.search("demo", "alpha", { ref: "feat/CONTEXT", context: 2 });
    const file = result.context?.files.find((entry) => entry.path === "ctx.txt");
    // [1..5] from the run, then [8..12] and [13..15] are one hunk because they touch.
    assert.deepEqual(
      file?.lines.map((line) => line.line),
      [1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15],
    );
  });

  it("stops reading after the context budget and says which files got no context", async () => {
    const result = await store.search("demo", "manyMarker", { ref: "feat/MANY", context: 1 });
    assert.equal(result.files, 21);
    assert.equal(result.context?.files.length, 21);

    const without = (result.context?.files ?? []).filter((entry) => entry.note !== undefined);
    assert.equal(without.length, 1, "twenty files are read; the twenty-first is named, not read");
    assert.match(without[0]?.note ?? "", /first 20 files/);
    assert.deepEqual(without[0]?.lines, []);
  });

  it("refuses context for the modes that have no matched line", async () => {
    await assert.rejects(
      store.search("demo", "alpha", { ref: "feat/CONTEXT", output: "files", context: 1 }),
      /context needs output "matches"/,
    );
    await assert.rejects(
      store.search("demo", "alpha", { ref: "feat/CONTEXT", output: "count", context: 2 }),
      /context needs output "matches"/,
    );
  });

  it("has no context when it was not asked for", async () => {
    const result = await store.search("demo", "alpha", { ref: "feat/CONTEXT" });
    assert.equal(result.context, undefined);
  });
});

describe("pickaxe over a fixture", () => {
  it("finds the commit that introduced a string", async () => {
    const result = await store.pickaxe("demo", "Button", { ref: "fix/TEST-1" });
    assert.equal(result.entries.length, 1);
    assert.match(result.entries[0]?.subject ?? "", /branch change/);
    assert.match(result.entries[0]?.date ?? "", /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(result.ref, "fix/TEST-1");
  });

  it("follows the text whatever its case, unless asked to be exact", async () => {
    // `git log -S` is literal *and* case-sensitive on its own, so the default
    // here is set deliberately: otherwise it answers "no commit ever changed
    // this" about text the caller is looking straight at, which is what it did
    // against the real project before this default existed.
    const loose = await store.pickaxe("demo", "BUTTON", { ref: "fix/TEST-1" });
    assert.equal(loose.entries.length, 1);
    assert.equal(loose.caseSensitive, false);

    const exact = await store.pickaxe("demo", "BUTTON", { ref: "fix/TEST-1", caseSensitive: true });
    assert.deepEqual(exact.entries, []);
    assert.equal(exact.caseSensitive, true);
  });

  it("caps the history walk, reports it, and follows a path", async () => {
    commitOnBranch(fixture.work, "main", "src/a.ts", "export const tokenX = 1;\n", "add tokenX");
    commitOnBranch(
      fixture.work,
      "main",
      "src/b.ts",
      "export const tokenX = 2;\n",
      "use tokenX again",
    );
    await store.syncRepo("demo");

    const all = await store.pickaxe("demo", "tokenX");
    assert.equal(all.entries.length, 2);
    assert.equal(all.truncated, false);

    const capped = await store.pickaxe("demo", "tokenX", { limit: 1 });
    assert.equal(capped.entries.length, 1);
    assert.equal(capped.truncated, true);

    const scoped = await store.pickaxe("demo", "tokenX", { path: "src/a.ts" });
    assert.equal(scoped.entries.length, 1);
    assert.match(scoped.entries[0]?.subject ?? "", /add tokenX/);
  });

  it("answers with nothing rather than failing when the text never moved", async () => {
    const result = await store.pickaxe("demo", "zzz_never_committed_zzz");
    assert.deepEqual(result.entries, []);
    assert.equal(result.truncated, false);
  });

  it("rejects an empty query", async () => {
    await assert.rejects(() => store.search("demo", "   "), /query must not be empty/);
    await assert.rejects(() => store.pickaxe("demo", ""), /query must not be empty/);
  });
});
