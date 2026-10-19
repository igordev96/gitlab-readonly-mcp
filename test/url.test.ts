// GitLab URLs: parsing a link, splitting a ref that contains slashes, the line
// anchor, and the read path they feed. Offline, against the fixture's "GitLab".
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import type { Config } from "../src/config.js";
import { Git } from "../src/git.js";
import { RepoStore, sliceLines } from "../src/repoStore.js";
import { conflictingProject, formatRangeBody } from "../src/tools/files.js";
import { formatUrl } from "../src/tools/url.js";
import { parseGitlabUrl, parseLineAnchor, resolveUrlParts } from "../src/url.js";
import { buildFixture, commitOnBranch } from "./fixture.js";

const fixture = buildFixture(path.join(os.tmpdir(), "glmcp-fixture-url"));

/** A file whose line numbers are knowable, and a big one, both on the branch. */
commitOnBranch(
  fixture.work,
  "fix/TEST-1",
  "src/lines.txt",
  "one\ntwo\nthree\nfour\nfive\n",
  "add lines",
);
commitOnBranch(
  fixture.work,
  "fix/TEST-1",
  "src/big.txt",
  Array.from({ length: 5000 }, (_, index) => `line ${index + 1} ${"x".repeat(40)}`).join("\n") +
    "\n",
  "add a big file",
);

const HOST = "https://gitlab.example.com";

const config: Config = {
  host: HOST,
  token: "",
  cacheDir: path.join(fixture.root, "cache"),
  gitBin: "git",
  fetchMode: "ttl",
  fetchTtlSeconds: 600,
};

// Registered as a clone of the fixture's bare "server", so resolution and reads
// need no network. The link's refs are the ones this project actually has.
const store = new RepoStore(config, new Git({ bin: "git" }));
await store.addRepo("demo", fixture.server);

const blob = (rest: string): string => `${HOST}/demo/-/blob/${rest}`;
const tree = (rest: string): string => `${HOST}/demo/-/tree/${rest}`;

describe("parseGitlabUrl", () => {
  it("reads a blob link into a project and a still-glued ref-and-path", () => {
    const parsed = parseGitlabUrl(blob("develop/src/index.tsx"), HOST);
    assert.equal(parsed.host, "gitlab.example.com");
    assert.equal(parsed.project, "demo");
    assert.equal(parsed.target, "file");
    assert.equal(parsed.rest, "develop/src/index.tsx");
    assert.equal(parsed.lines, undefined);
  });

  it("treats raw and blame links as files, and tree links as directories", () => {
    assert.equal(parseGitlabUrl(`${HOST}/demo/-/raw/main/a.ts`, HOST).target, "file");
    assert.equal(parseGitlabUrl(`${HOST}/demo/-/blame/main/a.ts`, HOST).target, "file");
    assert.equal(parseGitlabUrl(tree("main/src"), HOST).target, "directory");
  });

  it("takes the line anchor and the ref_type preference from the query and fragment", () => {
    const parsed = parseGitlabUrl(
      `${HOST}/demo/-/blob/fix/TEST-1/src/index.tsx?ref_type=tags#L12-L20`,
      HOST,
    );
    assert.deepEqual(parsed.lines, { from: 12, to: 20 });
    assert.equal(parsed.refTypeHint, "tag");
  });

  it("accepts a link without a scheme, and one wrapped in angle brackets", () => {
    const bare = "gitlab.example.com/demo/-/blob/main/src/index.tsx";
    assert.equal(parseGitlabUrl(bare, HOST).project, "demo");
    assert.equal(parseGitlabUrl(`<${HOST}/demo/-/blob/main/a.ts>`, HOST).rest, "main/a.ts");
  });

  it("decodes a percent-escaped path, which is how a space arrives", () => {
    assert.equal(parseGitlabUrl(blob("main/src/a%20b.ts"), HOST).rest, "main/src/a b.ts");
  });

  it("refuses a link to another GitLab, naming both hosts", () => {
    assert.throws(
      () => parseGitlabUrl("https://elsewhere.example.com/demo/-/blob/main/a.ts", HOST),
      /does not match GITLAB_HOST/,
    );
  });

  it("refuses a commit link by name rather than treating it as a path", () => {
    assert.throws(
      () => parseGitlabUrl(`${HOST}/demo/-/commit/abc1234`, HOST),
      /is a commit link, not a file or directory/,
    );
    assert.throws(() => parseGitlabUrl(`${HOST}/demo/-/commits/main`, HOST), /is a commit link/);
  });

  it("refuses merge request and other non-file links by name", () => {
    assert.throws(
      () => parseGitlabUrl(`${HOST}/demo/-/merge_requests/12`, HOST),
      /is a merge request link/,
    );
    assert.throws(() => parseGitlabUrl(`${HOST}/demo/-/issues/3`, HOST), /is an issue link/);
  });

  it("refuses an unknown segment, a clone URL, a bare project and junk", () => {
    assert.throws(
      () => parseGitlabUrl(`${HOST}/demo/-/something/1`, HOST),
      /is not a file or directory link/,
    );
    assert.throws(() => parseGitlabUrl(`${HOST}/demo.git`, HOST), /is not a file or directory link/);
    assert.throws(() => parseGitlabUrl(`${HOST}/demo`, HOST), /is not a file or directory link/);
    assert.throws(() => parseGitlabUrl("not a url at all", HOST), /Not a URL/);
    assert.throws(() => parseGitlabUrl("   ", HOST), /must not be empty/);
  });

  it("refuses a link with nothing after the segment", () => {
    assert.throws(() => parseGitlabUrl(`${HOST}/demo/-/blob`, HOST), /names no ref and no path/);
    assert.throws(() => parseGitlabUrl(`${HOST}/demo/-/tree`, HOST), /names no ref/);
  });

  it("keeps a link that names a ref but no path, for the tool to explain", () => {
    // `/-/blob/develop` is a real (if odd) link: a read that finds no path has to
    // say so, and `/-/tree/develop` is the ordinary root-of-the-repo link.
    assert.equal(parseGitlabUrl(blob("develop"), HOST).rest, "develop");
    assert.equal(parseGitlabUrl(tree("develop"), HOST).rest, "develop");
    assert.equal(parseGitlabUrl(tree("develop"), HOST).target, "directory");
  });

  it("reports a GITLAB_HOST that is not a URL instead of comparing rubbish", () => {
    assert.throws(() => parseGitlabUrl(blob("main/a.ts"), "not a url"), /is not a URL/);
  });
});

describe("parseLineAnchor", () => {
  it("reads #L12, #L12-20 and #L12-L20", () => {
    assert.deepEqual(parseLineAnchor("#L12"), { from: 12, to: 12 });
    assert.deepEqual(parseLineAnchor("#L12-20"), { from: 12, to: 20 });
    assert.deepEqual(parseLineAnchor("#L12-L20"), { from: 12, to: 20 });
  });

  it("orders a backwards range and ignores anything else", () => {
    assert.deepEqual(parseLineAnchor("#L20-12"), { from: 12, to: 20 });
    assert.equal(parseLineAnchor("#some-heading"), undefined);
    assert.equal(parseLineAnchor("#L0"), undefined);
    assert.equal(parseLineAnchor(""), undefined);
  });
});

describe("resolveUrlParts", () => {
  const refs = [
    { name: "fix", kind: "branch" as const },
    { name: "fix/TEST-1", kind: "branch" as const },
    { name: "develop", kind: "branch" as const },
    { name: "v1.0", kind: "tag" as const },
  ];

  it("takes the longest ref that is a prefix, which is what GitLab does", () => {
    const parts = resolveUrlParts("fix/TEST-1/src/index.tsx", refs);
    assert.deepEqual(parts, {
      ref: "fix/TEST-1",
      path: "src/index.tsx",
      confirmed: true,
      refKind: "branch",
    });
  });

  it("finds a ref that is the whole remainder, with no path", () => {
    assert.deepEqual(resolveUrlParts("develop", refs), {
      ref: "develop",
      path: "",
      confirmed: true,
      refKind: "branch",
    });
  });

  it("keeps a slashed ref intact when the path is deep", () => {
    assert.equal(resolveUrlParts("fix/TEST-1/a/b/c.ts", refs).path, "a/b/c.ts");
    assert.equal(resolveUrlParts("fix/TEST-1/a/b/c.ts", refs).ref, "fix/TEST-1");
  });

  it("falls back to the first segment, unconfirmed, when no ref matches", () => {
    assert.deepEqual(resolveUrlParts("nope/src/index.tsx", refs), {
      ref: "nope",
      path: "src/index.tsx",
      confirmed: false,
    });
  });

  it("prefers the hint when a branch and a tag share a name", () => {
    const both = [
      { name: "v1.0", kind: "branch" as const },
      { name: "v1.0", kind: "tag" as const },
    ];
    assert.equal(resolveUrlParts("v1.0/x", both, "tag").refKind, "tag");
    assert.equal(resolveUrlParts("v1.0/x", both).refKind, "branch");
  });

  it("tolerates stray slashes around the remainder", () => {
    assert.deepEqual(resolveUrlParts("/develop/", refs), {
      ref: "develop",
      path: "",
      confirmed: true,
      refKind: "branch",
    });
  });
});

describe("sliceLines", () => {
  it("cuts an inclusive, 1-based range", () => {
    assert.equal(sliceLines("a\nb\nc\nd\n", { from: 2, to: 3 }).text, "b\nc");
  });

  it("clamps a range that runs past the end, and reports the true count", () => {
    const sliced = sliceLines("a\nb\nc\n", { from: 2, to: 9 });
    assert.equal(sliced.text, "b\nc");
    assert.equal(sliced.availableFrom, 2);
    assert.equal(sliced.availableTo, 3);
    assert.equal(sliced.fileLines, 3);
  });

  it("returns nothing, with the count, when the range starts past the end", () => {
    const sliced = sliceLines("a\nb\n", { from: 5, to: 6 });
    assert.equal(sliced.text, "");
    assert.equal(sliced.availableFrom, undefined);
    assert.equal(sliced.fileLines, 2);
  });

  it("does not count a trailing newline as a line, and handles an empty file", () => {
    assert.equal(sliceLines("a\n", { from: 1, to: 9 }).fileLines, 1);
    assert.equal(sliceLines("", { from: 1, to: 2 }).fileLines, 0);
  });

  it("keeps CRLF endings with their line", () => {
    assert.equal(sliceLines("a\r\nb\r\nc\r\n", { from: 2, to: 3 }).text, "b\r\nc\r");
  });
});

describe("RepoStore.resolveUrl", () => {
  it("splits a slashed ref using the project's own refs, and resolves it", async () => {
    const parsed = await store.resolveUrl(blob("fix/TEST-1/src/index.tsx"));
    assert.equal(parsed.project, "demo");
    assert.equal(parsed.ref, "fix/TEST-1");
    assert.equal(parsed.path, "src/index.tsx");
    assert.equal(parsed.refConfirmed, true);
    assert.equal(parsed.refKind, "branch");
    assert.match(parsed.commit ?? "", /^[0-9a-f]{40}$/);
    assert.equal(parsed.source, "local");
  });

  it("reads the file the link points at, with the ref it split out", async () => {
    const parsed = await store.resolveUrl(blob("fix/TEST-1/src/index.tsx"));
    const read = await store.readFile(parsed.project, parsed.ref, parsed.path);
    assert.equal(read.content, "export const hello = 'fix/TEST-1';\n");
  });

  it("takes a tag link, and says the ref is a tag", async () => {
    const parsed = await store.resolveUrl(blob("v1.0/src/index.tsx"));
    assert.equal(parsed.ref, "v1.0");
    assert.equal(parsed.refKind, "tag");
    assert.equal(parsed.refConfirmed, true);
  });

  it("lists the directory a tree link names", async () => {
    const parsed = await store.resolveUrl(tree("fix/TEST-1/src"));
    assert.equal(parsed.target, "directory");
    assert.equal(parsed.ref, "fix/TEST-1");
    assert.equal(parsed.path, "src");
    const listing = await store.listTree(parsed.project, parsed.ref, parsed.path);
    assert.deepEqual(
      listing.entries.map((entry) => entry.path),
      ["src/big.txt", "src/components", "src/index.tsx", "src/lines.txt"],
    );
  });

  it("honours a #L2-4 anchor all the way into the read", async () => {
    const parsed = await store.resolveUrl(blob("fix/TEST-1/src/lines.txt?a=1#L2-4"));
    assert.deepEqual(parsed.lines, { from: 2, to: 4 });
    const read = await store.readFile(parsed.project, parsed.ref, parsed.path, 200_000, {
      lines: parsed.lines,
    });
    assert.equal(read.content, "two\nthree\nfour");
    assert.deepEqual(read.lines, {
      from: 2,
      to: 4,
      availableFrom: 2,
      availableTo: 4,
      fileLines: 5,
    });
    assert.equal(formatRangeBody(read.lines!, read.content), "2: two\n3: three\n4: four");
  });

  it("reaches a line past a small byte cap, because the range needs the whole file", async () => {
    const parsed = await store.resolveUrl(blob("fix/TEST-1/src/big.txt#L4999-5000"));
    const read = await store.readFile(parsed.project, parsed.ref, parsed.path, 1_000, {
      lines: parsed.lines,
    });
    assert.equal(read.content, `line 4999 ${"x".repeat(40)}\nline 5000 ${"x".repeat(40)}`);
    assert.equal(read.truncated, false);
    assert.equal(read.lines?.fileLines, 5000);
  });

  it("says when a range is past the end, rather than returning an empty file silently", async () => {
    const read = await store.readFile("demo", "fix/TEST-1", "src/lines.txt", 200_000, {
      lines: { from: 9, to: 12 },
    });
    assert.equal(read.content, "");
    assert.match(formatRangeBody(read.lines!, read.content), /has 5 lines, so 9-12 are past/);
  });

  it("clamps a range that runs past the end and says what came back", async () => {
    const read = await store.readFile("demo", "fix/TEST-1", "src/lines.txt", 200_000, {
      lines: { from: 3, to: 99 },
    });
    assert.match(formatRangeBody(read.lines!, read.content), /3-99 were asked for; the file has 5/);
  });

  it("parses offline with resolve: false, splitting at the first segment", async () => {
    const parsed = await store.resolveUrl(blob("fix/TEST-1/src/index.tsx"), { resolve: false });
    assert.equal(parsed.ref, "fix");
    assert.equal(parsed.path, "TEST-1/src/index.tsx");
    assert.equal(parsed.refConfirmed, false);
    assert.equal(parsed.commit, undefined);
    assert.equal(parsed.source, undefined);
    assert.match(formatUrl(parsed), /not resolved: resolve=false/);
    // Nothing was touched: no mirror for this project exists in this cache.
    assert.equal(parsed.project, "demo");
  });

  it("labels an unresolvable ref as unconfirmed and leaves commit unset", async () => {
    const parsed = await store.resolveUrl(blob("no-such-branch/src/index.tsx"));
    assert.equal(parsed.refConfirmed, false);
    assert.equal(parsed.commit, undefined);
    assert.match(formatUrl(parsed), /no ref of demo matches the start of this link/);
  });

  it("refuses a foreign host before anything is resolved", async () => {
    await assert.rejects(
      () => store.resolveUrl("https://elsewhere.example.com/demo/-/blob/main/a.ts"),
      /does not match GITLAB_HOST/,
    );
  });

  it("says a file link names no file when the ref is the whole remainder", async () => {
    const parsed = await store.resolveUrl(blob("develop"));
    assert.equal(parsed.ref, "develop");
    assert.equal(parsed.path, "");
    assert.match(formatUrl(parsed), /names a ref but no file/);
  });
});

describe("conflictingProject", () => {
  it("accepts a project that agrees with the link", () => {
    assert.equal(conflictingProject(blob("main/src/a.ts"), "demo", config), undefined);
    assert.equal(conflictingProject(blob("main/src/a.ts"), " /demo/ ", config), undefined);
    assert.equal(conflictingProject(blob("main/src/a.ts"), undefined, config), undefined);
    assert.equal(conflictingProject(undefined, "demo", config), undefined);
  });

  it("catches a project that contradicts the link before anything is mirrored", () => {
    assert.equal(
      conflictingProject(blob("main/src/a.ts"), "other/repo", config),
      'The URL names "demo", but project="other/repo" was given; pass one or the other.',
    );
    // Project paths are compared as written, the way the store validates them.
    assert.match(conflictingProject(blob("main/src/a.ts"), "Demo", config) ?? "", /names "demo"/);
  });
});

describe("formatUrl", () => {
  it("renders the pieces, the provenance and the line range", async () => {
    const parsed = await store.resolveUrl(blob("fix/TEST-1/src/lines.txt#L2-4"));
    const rendered = formatUrl(parsed);
    assert.match(rendered, /^<url /);
    assert.match(rendered, /project="demo"/);
    assert.match(rendered, /target="file"/);
    assert.match(rendered, /ref="fix\/TEST-1"/);
    assert.match(rendered, /path="src\/lines\.txt"/);
    assert.match(rendered, /lines="2-4"/);
    assert.match(rendered, /ref_kind="branch"/);
    assert.match(rendered, /ref_confirmed="true"/);
    assert.match(rendered, /commit="[0-9a-f]{40}"/);
    assert.match(rendered, /source="local"/);
    assert.match(rendered, /\n<\/url>$/);
  });

  it("renders a tree link's root path as /", async () => {
    const parsed = await store.resolveUrl(tree("main"));
    assert.equal(parsed.path, "");
    assert.match(formatUrl(parsed), /path="\/"/);
  });
});
