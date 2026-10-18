// Search layer: `git grep` and `git log -S`, their parsers, and their renderers.
// Runs offline against a fixture "GitLab" built in the temp directory.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Config } from "../src/config.js";
import { Git } from "../src/git.js";
import {
  NotFoundError,
  RepoStore,
  parseGrepMatches,
  parsePickaxeEntries,
  type PickaxeResult,
  type SearchResult,
} from "../src/repoStore.js";
import { formatPickaxe, formatSearch, matchLine } from "../src/tools/search.js";
import { buildFixture, commitOnBranch, publishBranchFromElsewhere } from "./fixture.js";

const fixture = buildFixture(path.join(os.tmpdir(), "glmcp-fixture-search"));

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
    matches: [],
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
    assert.match(text, /\nsrc\/a\.ts\n {2}1: const hello = 1;\n {2}9: log\("hello"\)\nsrc\/b\.tsx\n {2}4: \{hello\}\n<\/search>$/);
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
      searchResult({ regex: true, caseSensitive: true, path: "src", refreshError: "token rejected" }),
    );
    assert.match(text, /regex="true" case_sensitive="true" path="src"/);
    assert.match(text, /refresh_failed="true"/);
    assert.match(text, /\[refresh failed: token rejected\]/);
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
    assert.match(rows, /^<pickaxe project="demo" ref="main" commit="a{40}" query="hello" count="1"/);
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
    assert.match(text, /\[truncated: showing the most recent 1 commits; raise "limit" for older ones\]/);
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

    const nothing = await store.search("demo", "export const", { ref: "fix/TEST-1", path: "no/such/dir" });
    assert.equal(nothing.total, 0);
  });

  it("accepts a query that starts with a dash", async () => {
    commitOnBranch(fixture.work, "main", "src/flags.ts", "run('--dry-run');\n", "add a dashed flag");
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
    execFileSync("git", ["clone", "-q", fixture.server, clone], { stdio: ["ignore", "pipe", "pipe"] });
    // Published after the clone was made, so the clone holds it only as
    // `refs/remotes/origin/…` and the read has to fetch to find it.
    publishBranchFromElsewhere(fixture.server, "feat/REMOTE-ONLY", "remote.txt", "remoteOnlyMarker\n");

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
    commitOnBranch(fixture.work, "main", "src/b.ts", "export const tokenX = 2;\n", "use tokenX again");
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
    await assert.rejects(
      () => store.search("demo", "   "),
      /query must not be empty/,
    );
    await assert.rejects(
      () => store.pickaxe("demo", ""),
      /query must not be empty/,
    );
  });
});
