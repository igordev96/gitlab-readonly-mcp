// Store layer: mirror resolution, ref/path guards, and the freshness policy.
// Runs entirely offline against a fixture "GitLab" built in the temp directory.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Config } from "../src/config.js";
import { Git } from "../src/git.js";
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
});
