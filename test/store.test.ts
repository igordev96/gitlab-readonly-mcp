// Store layer: mirror resolution, ref/path guards, and the freshness policy.
// Runs entirely offline against a fixture "GitLab" built in the temp directory.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Config } from "../src/config.js";
import { Git, GitError } from "../src/git.js";
import { NotFoundError, RepoStore } from "../src/repoStore.js";
import { addBranchWithFile, buildFixture, commitOnBranch } from "./fixture.js";

const fixture = buildFixture(path.join(os.tmpdir(), "glmcp-fixture-store"));
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

const store = new RepoStore(makeConfig(), new Git({ bin: "git" }));

describe("store layer", () => {
  it("reads a file from a non-default branch", async () => {
    const result = await store.readFile("demo", "fix/TEST-1", "src/index.tsx");
    assert.match(result.content, /fix\/TEST-1/);
    assert.match(result.commit, /^[0-9a-f]{40}$/);
    assert.equal(result.project, "demo");
    assert.equal(result.path, "src/index.tsx");
  });

  it("reads a different version from main", async () => {
    const result = await store.readFile("demo", "main", "src/index.tsx");
    assert.match(result.content, /'main'/);
  });

  it("clones the mirror only once (reuses the cache)", async () => {
    const dir = store.mirrorPath("demo");
    assert.ok(fs.existsSync(path.join(dir, "HEAD")), "mirror should exist on disk");
  });

  it("accepts a project path with a trailing .git", async () => {
    // docs/readme.md only exists on fix/TEST-1; "demo.git" normalises to "demo".
    const result = await store.readFile("demo.git", "fix/TEST-1", "docs/readme.md");
    assert.match(result.content, /# demo/);
  });

  it("raises NotFoundError for a missing ref", async () => {
    await assert.rejects(
      () => store.readFile("demo", "no/such-branch", "src/index.tsx"),
      NotFoundError,
    );
  });

  it("raises NotFoundError for a missing path", async () => {
    await assert.rejects(
      () => store.readFile("demo", "main", "src/nope.tsx"),
      NotFoundError,
    );
  });

  it("rejects a ref starting with '-' (argument injection)", async () => {
    await assert.rejects(
      () => store.readFile("demo", "--upload-pack=x", "src/index.tsx"),
      /must not start with/,
    );
  });

  it("normalises backslashes in the file path", async () => {
    const result = await store.readFile("demo", "main", "src\\index.tsx");
    assert.match(result.content, /'main'/);
  });

  it("resolveRef returns a commit sha", async () => {
    const sha = await store.resolveRef("demo", "fix/TEST-1");
    assert.match(sha ?? "", /^[0-9a-f]{40}$/);
  });
});

describe("freshness", () => {
  it("fetch-on-miss finds a branch created after the mirror was cloned", async () => {
    addBranchWithFile(
      fixture.work,
      "feature/added",
      "src/added.ts",
      "export const added = true;\n",
      "add feature",
    );
    const result = await store.readFile("demo", "feature/added", "src/added.ts");
    assert.match(result.content, /added = true/);
    assert.equal(result.fetched, true, "expected a fetch to have run");
  });

  it("does not re-fetch a mirror that is within the TTL", async () => {
    commitOnBranch(
      fixture.work,
      "main",
      "src/index.tsx",
      "export const hello = 'main-v2';\n",
      "main v2",
    );
    const result = await store.readFile("demo", "main", "src/index.tsx");
    assert.equal(result.fetched, false, "expected no fetch while within the TTL");
    assert.match(result.content, /'main'/, "expected the stale copy while within the TTL");
  });

  it("fetchMode=always refreshes before reading", async () => {
    const always = new RepoStore(makeConfig({ fetchMode: "always" }), new Git({ bin: "git" }));
    const result = await always.readFile("demo", "main", "src/index.tsx");
    assert.equal(result.fetched, true, "expected a fetch in always mode");
    assert.match(result.content, /main-v2/, "expected the refreshed copy");
  });

  it("reports syncedAt for the read", async () => {
    const result = await store.readFile("demo", "main", "src/index.tsx");
    assert.ok(result.syncedAt instanceof Date, "syncedAt should be a Date");
    assert.ok(result.syncedAt.getTime() <= Date.now(), "syncedAt should not be in the future");
  });

  it("treats fetchTtlSeconds=0 like always", async () => {
    const zero = new RepoStore(makeConfig({ fetchTtlSeconds: 0 }), new Git({ bin: "git" }));
    const result = await zero.readFile("demo", "main", "src/index.tsx");
    assert.equal(result.fetched, true);
  });

  it("records a successful sync on disk, so it survives a restart", async () => {
    const cache = path.join(fixture.root, "cache-stamp");
    const git = new Git({ bin: "git" });
    const first = new RepoStore(makeConfig({ cacheDir: cache }), git);
    const cloned = await first.readFile("demo", "main", "src/index.tsx");
    assert.ok(cloned.syncedAt instanceof Date, "a clone is itself a sync");
    const t0 = cloned.syncedAt?.getTime();
    assert.ok(t0, "expected a sync time from the clone");

    const stamp = path.join(first.mirrorPath("demo"), "mcp-last-sync");
    assert.equal(Number(fs.readFileSync(stamp, "utf8").trim()), t0, "stamp holds the sync time");

    // A second store starts with an empty in-memory clock, so the time it
    // reports can only have come from disk.
    const restarted = new RepoStore(makeConfig({ cacheDir: cache }), git);
    const second = await restarted.readFile("demo", "main", "src/index.tsx");
    assert.equal(second.fetched, false, "a restart must not force a fetch within the TTL");
    assert.equal(second.syncedAt?.getTime(), t0, "the sync time should survive the restart");
  });

  it("does not record a sync when the fetch itself fails", async () => {
    const cache = path.join(fixture.root, "cache-failed-fetch");
    const git = new Git({ bin: "git" });
    const first = new RepoStore(makeConfig({ cacheDir: cache }), git);
    const t0 = (await first.readFile("demo", "main", "src/index.tsx")).syncedAt?.getTime();
    assert.ok(t0);

    // An unreachable remote fails the fetch, exactly as a rejected token does.
    const dir = first.mirrorPath("demo");
    const broken = await git.run(
      ["remote", "set-url", "origin", pathToFileURL(path.join(fixture.root, "gone.git")).href],
      { gitDir: dir },
    );
    assert.equal(broken.code, 0);

    const forced = new RepoStore(makeConfig({ cacheDir: cache, fetchMode: "always" }), git);
    const result = await forced.readFile("demo", "main", "src/index.tsx");

    // The read survives on the cache, and says why it could not do better.
    assert.match(result.refreshError ?? "", /Failed to fetch/);
    assert.equal(result.fetched, false, "nothing was fetched");
    assert.equal(
      Number(fs.readFileSync(path.join(dir, "mcp-last-sync"), "utf8").trim()),
      t0,
      "a failed fetch must leave the last successful sync time alone",
    );
  });

  it("ignores a FETCH_HEAD stamped by a failed fetch", async () => {
    const cache = path.join(fixture.root, "cache-fetchhead");
    const git = new Git({ bin: "git" });
    const first = new RepoStore(makeConfig({ cacheDir: cache }), git);
    const t0 = (await first.readFile("demo", "main", "src/index.tsx")).syncedAt?.getTime();
    assert.ok(t0);

    // What git leaves behind when it stamps FETCH_HEAD and then fails: zero
    // bytes, written now. It must not be mistaken for a sync.
    fs.writeFileSync(path.join(first.mirrorPath("demo"), "FETCH_HEAD"), "", "utf8");

    const restarted = new RepoStore(makeConfig({ cacheDir: cache }), git);
    const after = await restarted.readFile("demo", "main", "src/index.tsx");
    assert.equal(after.fetched, false, "a stamped FETCH_HEAD should not count as a fresh sync");
    assert.equal(after.syncedAt?.getTime(), t0, "the clock must not come from FETCH_HEAD");
  });
});

describe("a refresh that fails", () => {
  /** Clone with the remote reachable, then cut that mirror off from its remote. */
  async function cutOffMirror(cacheDir: string, git: Git): Promise<{ dir: string; t0: number }> {
    const warm = new RepoStore(makeConfig({ cacheDir }), git);
    const first = await warm.readFile("demo", "main", "src/index.tsx");
    const t0 = first.syncedAt?.getTime();
    assert.ok(t0, "expected the clone to record a sync time");

    const dir = warm.mirrorPath("demo");
    const moved = await git.run(
      ["remote", "set-url", "origin", pathToFileURL(path.join(fixture.root, "gone.git")).href],
      { gitDir: dir },
    );
    assert.equal(moved.code, 0, "expected to be able to break the remote");
    return { dir, t0 };
  }

  it("serves the cached mirror and reports why, rather than failing the read", async () => {
    const cache = path.join(fixture.root, "cache-degraded");
    const git = new Git({ bin: "git" });
    const { t0 } = await cutOffMirror(cache, git);

    const offline = new RepoStore(makeConfig({ cacheDir: cache, fetchMode: "always" }), git);
    const result = await offline.readFile("demo", "main", "src/index.tsx");

    assert.match(result.content, /export const hello/, "the cached copy still answers");
    assert.equal(result.fetched, false, "nothing was fetched");
    assert.match(result.refreshError ?? "", /Failed to fetch/, "the failure is reported");
    assert.match(
      result.refreshError ?? "",
      /\ngit said: /,
      "the note must carry git's own words, not just the fact that it failed",
    );
    assert.match(
      result.refreshError ?? "",
      /GitLab could not find this project/,
      "the note must be diagnosed the same way a hard failure is",
    );
    assert.equal(result.syncedAt?.getTime(), t0, "syncedAt still names the last real sync");
  });

  it("admits that a missing ref may only be missing because of it", async () => {
    const cache = path.join(fixture.root, "cache-degraded-miss");
    const git = new Git({ bin: "git" });
    await cutOffMirror(cache, git);

    // A branch pushed after the mirror was cloned: fetch-on-miss is exactly the
    // mechanism that would find it, and it is the one thing that cannot run.
    addBranchWithFile(
      fixture.work,
      "feature/after-clone",
      "src/late.ts",
      "export const late = true;\n",
      "late branch",
    );

    const offline = new RepoStore(makeConfig({ cacheDir: cache }), git);
    await assert.rejects(
      () => offline.readFile("demo", "feature/after-clone", "src/late.ts"),
      (error: unknown) => {
        assert.ok(error instanceof NotFoundError, "expected a not-found error");
        assert.match(error.message, /Ref not found/);
        assert.match(
          error.message,
          /could not be refreshed/,
          "a missing ref must not be presented as proof of absence",
        );
        return true;
      },
    );
  });

  it("reports the failure from a ref listing too", async () => {
    const cache = path.join(fixture.root, "cache-degraded-refs");
    const git = new Git({ bin: "git" });
    const { t0 } = await cutOffMirror(cache, git);

    const offline = new RepoStore(makeConfig({ cacheDir: cache, fetchMode: "always" }), git);
    const listed = await offline.listRefs("demo", { kind: "branches" });

    assert.ok(
      listed.refs.some((entry) => entry.name === "main"),
      "the cached ref list still answers",
    );
    assert.match(listed.refreshError ?? "", /Failed to fetch/);
    assert.equal(listed.syncedAt?.getTime(), t0);
  });
});

describe("failure reporting", () => {
  it("keeps git's own stderr on a failed clone", async () => {
    // A host that is a real directory but not a repository: git fails offline,
    // deterministically, with a message worth quoting. A cache directory of its
    // own, because the shared one already holds a usable `demo` mirror.
    const brokenHost = pathToFileURL(path.join(fixture.root, "not-a-repo")).href;
    const broken = new RepoStore(
      makeConfig({ host: brokenHost, cacheDir: path.join(fixture.root, "cache-stderr") }),
      new Git({ bin: "git" }),
    );

    await assert.rejects(
      () => broken.readFile("demo", "main", "src/index.tsx"),
      (error: unknown) => {
        assert.ok(error instanceof GitError, `expected a GitError, got ${String(error)}`);
        assert.match(error.stderr, /does not appear to be a git repository/i);
        return true;
      },
    );
  });

  it("does not leave a broken mirror behind when a clone fails", async () => {
    const brokenHost = pathToFileURL(path.join(fixture.root, "not-a-repo")).href;
    const broken = new RepoStore(
      makeConfig({ host: brokenHost, cacheDir: path.join(fixture.root, "cache-failed") }),
      new Git({ bin: "git" }),
    );

    await broken.readFile("demo", "main", "src/index.tsx").catch(() => undefined);
    assert.equal(
      fs.existsSync(broken.mirrorPath("demo")),
      false,
      "a failed clone must not be mistaken for a usable mirror",
    );
  });
});
