// Local-clone sources: registering a project's own checkout, reading from it
// without touching the working tree, and fetching into it only when a ref is
// missing. Runs entirely offline against a fixture "GitLab".
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Config } from "../src/config.js";
import { Git } from "../src/git.js";
import { NotFoundError, RepoStore } from "../src/repoStore.js";
import { SourceManager } from "../src/sources.js";
import { buildFixture, publishBranchFromElsewhere } from "./fixture.js";

const fixture = buildFixture(path.join(os.tmpdir(), "glmcp-fixture-local"));
const git = new Git({ bin: "git" });

/** A store with a cache of its own, so no test can see another's registry. */
function makeStore(name: string, overrides: Partial<Config> = {}): RepoStore {
  const config: Config = {
    host: pathToFileURL(fixture.root).href,
    token: "",
    cacheDir: path.join(fixture.root, `cache-${name}`),
    gitBin: "git",
    fetchMode: "ttl",
    fetchTtlSeconds: 600,
    ...overrides,
  };
  return new RepoStore(config, git);
}

/** Write a registry by hand, the way a user sets a per-project policy. */
function registerEntry(cache: string, project: string, entry: Record<string, unknown>): void {
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(
    path.join(cache, "repos.json"),
    JSON.stringify({ version: 1, repos: { [project]: entry } }),
    "utf8",
  );
}

function statusOf(work: string): string {
  return execFileSync("git", ["-C", work, "status", "--porcelain"], { encoding: "utf8" });
}

function commitIn(work: string, message: string): void {
  execFileSync(
    "git",
    ["-C", work, "-c", "user.email=test@example.com", "-c", "user.name=Test",
      "commit", "-q", "-m", message],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** A repository of its own, with one commit and no remote. */
function makeLonelyRepo(name: string): string {
  const dir = path.join(fixture.root, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  fs.writeFileSync(path.join(dir, "README.md"), "# lonely\n");
  execFileSync("git", ["-C", dir, "add", "-A"], { encoding: "utf8" });
  commitIn(dir, "initial");
  return dir;
}

describe("registering a local clone", () => {
  it("reads from the clone instead of a mirror", async () => {
    const store = makeStore("read");
    const added = await store.addRepo("demo", fixture.work);

    assert.equal(added.project, "demo");
    assert.equal(added.source, "local");
    assert.equal(added.localPath, path.resolve(fixture.work));
    assert.equal(added.updated, false);

    const result = await store.readFile("demo", "fix/TEST-1", "src/index.tsx");
    assert.match(result.content, /fix\/TEST-1/);
    assert.equal(
      fs.existsSync(store.mirrorPath("demo")),
      false,
      "a project read from a clone must not be mirrored as well",
    );

    const { repos } = await store.listRepos();
    assert.equal(repos.length, 1);
    assert.equal(repos[0]?.source, "local");
    assert.equal(repos[0]?.present, true);
    assert.equal(repos[0]?.localPath, path.resolve(fixture.work));
  });

  it("answers with the clone's own commit, even when it was never pushed", async () => {
    const store = makeStore("unpushed");
    await store.addRepo("demo", fixture.work);

    // Only this checkout has this commit; the server has never seen it.
    fs.writeFileSync(path.join(fixture.work, "local-only.txt"), "local\n");
    execFileSync("git", ["-C", fixture.work, "add", "local-only.txt"], { encoding: "utf8" });
    commitIn(fixture.work, "local only");

    const result = await store.readFile("demo", "main", "local-only.txt");
    assert.match(result.content, /local/);
  });

  it("accepts a bare repository, which has no working tree to disturb", async () => {
    const store = makeStore("bare");
    const added = await store.addRepo("demo", fixture.server);
    assert.equal(added.source, "local");

    const result = await store.readFile("demo", "main", "src/index.tsx");
    assert.match(result.content, /'main'/);
  });

  it("leaves the working tree exactly as it was", async () => {
    const store = makeStore("worktree");
    await store.addRepo("demo", fixture.work);

    const stray = path.join(fixture.work, "uncommitted.txt");
    fs.writeFileSync(stray, "not committed\n");
    const before = statusOf(fixture.work);
    assert.match(before, /uncommitted\.txt/, "the fixture should have something uncommitted");

    await store.readFile("demo", "fix/TEST-1", "src/index.tsx");
    await store.listTree("demo", "fix/TEST-1", "src");
    await store.listRefs("demo", { kind: "all" });

    assert.equal(statusOf(fixture.work), before, "git status must be unchanged");
    assert.equal(fs.readFileSync(stray, "utf8"), "not committed\n");
    fs.rmSync(stray);
  });
});

describe("reading a ref a clone does not have", () => {
  it("fetches it from the clone's own remote, then resolves it", async () => {
    publishBranchFromElsewhere(
      fixture.server,
      "feat/from-elsewhere",
      "src/elsewhere.ts",
      "export const elsewhere = 'yes';\n",
    );
    const store = makeStore("miss");
    await store.addRepo("demo", fixture.work);

    // Before any fetch the branch is invisible: nothing has refreshed the clone,
    // and a TTL fetch is deliberately not done to a clone that is not ours.
    const before = await store.listRefs("demo", { kind: "branches" });
    assert.equal(
      before.refs.some((entry) => entry.name === "feat/from-elsewhere"),
      false,
      "the clone does not have this branch yet",
    );

    const read = await store.readFile("demo", "feat/from-elsewhere", "src/elsewhere.ts");
    assert.match(read.content, /elsewhere = 'yes'/);
    assert.equal(read.fetched, true, "the miss should have fetched from the clone's remote");

    const after = await store.listRefs("demo", { kind: "branches" });
    const found = after.refs.find((entry) => entry.name === "feat/from-elsewhere");
    assert.ok(found, "the fetched branch should now be listed");
    assert.equal(found.kind, "branch");
    assert.equal(found.refname, "refs/remotes/origin/feat/from-elsewhere");

    // A branch the clone has locally is listed once, not twice, and the local one
    // is the one reported.
    const local = after.refs.filter((entry) => entry.name === "fix/TEST-1");
    assert.equal(local.length, 1);
    assert.equal(local[0]?.refname, "refs/heads/fix/TEST-1");

    const resolved = await store.resolveRefInfo("demo", "feat/from-elsewhere");
    assert.equal(resolved.kind, "branch", "a branch is still a branch when it is the remote's");
  });

  it("says a clone with no remote cannot fill the gap, rather than failing obscurely", async () => {
    const lonely = makeLonelyRepo("lonely");
    const store = makeStore("lonely");
    await store.addRepo("demo", lonely);

    // What the clone does have reads normally, and without a fetch.
    const read = await store.readFile("demo", "main", "README.md");
    assert.match(read.content, /lonely/);
    assert.equal(read.fetched, false, "a clone is not fetched on a timer");

    await assert.rejects(
      () => store.readFile("demo", "no/such-branch", "README.md"),
      (error: Error) => {
        assert.ok(error instanceof NotFoundError, `expected NotFoundError, got ${String(error)}`);
        assert.match(error.message, /Ref not found/);
        assert.match(error.message, /clone could not be refreshed/);
        assert.match(error.message, /no remote to fetch from/);
        return true;
      },
    );
  });
});

describe("freshness for a local clone", () => {
  it("does not fetch on the TTL, but does when policy says always", async () => {
    const ttlStore = makeStore("local-ttl");
    await ttlStore.addRepo("demo", fixture.work);
    const ttlRead = await ttlStore.readFile("demo", "main", "src/index.tsx");
    assert.equal(ttlRead.fetched, false, "`ttl` fetches a mirror, not someone's checkout");

    const cache = path.join(fixture.root, "cache-local-always");
    registerEntry(cache, "demo", {
      source: "local",
      localPath: fixture.work,
      cloneStrategy: "full",
      freshnessMode: "always",
    });
    const alwaysStore = makeStore("local-always", { cacheDir: cache });
    const alwaysRead = await alwaysStore.readFile("demo", "main", "src/index.tsx");
    assert.equal(alwaysRead.fetched, true, "`always` is the operator asking every time");
  });

  it("records a sync in the clone, so its age is a real time", async () => {
    publishBranchFromElsewhere(
      fixture.server,
      "feat/stamped",
      "src/stamped.ts",
      "export const stamped = true;\n",
    );
    const store = makeStore("stamped");
    await store.addRepo("demo", fixture.work);
    await store.readFile("demo", "feat/stamped", "src/stamped.ts");

    const stamp = path.join(fixture.work, ".git", "mcp-last-sync");
    assert.equal(fs.existsSync(stamp), true, "a successful fetch stamps the clone");

    const { repos } = await store.listRepos();
    assert.ok(repos[0]?.syncedAt instanceof Date, "the listing should report a real age");
  });
});

describe("add_repo and remove_repo", () => {
  it("registers a project before it is read, without fetching anything", async () => {
    const store = makeStore("register-only");
    const added = await store.addRepo("demo");
    assert.equal(added.source, "mirror");
    assert.equal(added.updated, false);

    const { repos } = await store.listRepos();
    assert.equal(repos.length, 1, "a registered project shows up before its first read");
    assert.equal(repos[0]?.present, false, "nothing is on disk until it is fetched");
    assert.equal(repos[0]?.syncedAt, undefined);
    assert.equal(fs.existsSync(store.mirrorPath("demo")), false, "registering is not fetching");
  });

  it("refuses a path that is not a repository, and registers nothing", async () => {
    const store = makeStore("bad-path");

    await assert.rejects(
      () => store.addRepo("demo", path.join(fixture.root, "does-not-exist")),
      /does not exist/,
    );
    await assert.rejects(() => store.addRepo("demo", fixture.root), /not a git repository/);
    assert.equal((await store.listRepos()).repos.length, 0);
  });

  it("fails clearly at read time when a registered clone has gone", async () => {
    const vanishing = makeLonelyRepo("vanishing");
    const store = makeStore("vanishing");
    await store.addRepo("demo", vanishing);
    fs.rmSync(vanishing, { recursive: true, force: true });

    const { repos } = await store.listRepos();
    assert.equal(repos[0]?.present, false, "a listing should not pretend the path is there");

    await assert.rejects(
      () => store.readFile("demo", "main", "README.md"),
      (error: Error) => {
        assert.match(error.message, /does not exist/);
        assert.match(error.message, /add_repo/);
        assert.match(error.message, /remove_repo/);
        return true;
      },
    );
  });

  it("forgets a registration and never touches the clone", async () => {
    const store = makeStore("remove");
    await store.addRepo("demo", fixture.work);

    const removed = await store.removeRepo("demo", { deleteMirror: true });
    assert.equal(removed.registered, true);
    assert.equal(removed.keptLocalClone, true, "delete_mirror must not delete a clone");
    assert.equal(removed.deletedMirror, undefined);
    assert.equal(fs.existsSync(path.join(fixture.work, ".git")), true);
    assert.equal((await store.listRepos()).repos.length, 0);

    const again = await store.removeRepo("demo");
    assert.equal(again.registered, false, "forgetting twice is not an error");
  });

  it("deletes a mirror when asked", async () => {
    const store = makeStore("remove-mirror");
    await store.addRepo("demo");
    const synced = await store.syncRepo("demo");
    assert.equal(synced.gitDir, store.mirrorPath("demo"));

    const removed = await store.removeRepo("demo", { deleteMirror: true });
    assert.equal(removed.deletedMirror, store.mirrorPath("demo"));
    assert.equal(fs.existsSync(store.mirrorPath("demo")), false);

    const kept = await store.removeRepo("demo");
    assert.equal(kept.registered, false);
  });

  it("refuses to delete anything outside the mirror cache", async () => {
    const sources = new SourceManager(
      {
        host: pathToFileURL(fixture.root).href,
        token: "",
        cacheDir: path.join(fixture.root, "cache-guard"),
        gitBin: "git",
        fetchMode: "ttl",
        fetchTtlSeconds: 600,
      },
      git,
    );

    await assert.rejects(
      () => sources.removeMirror("demo", fixture.work),
      /Refusing to delete/,
    );
    assert.equal(fs.existsSync(fixture.work), true, "the clone must still be there");
  });
});
