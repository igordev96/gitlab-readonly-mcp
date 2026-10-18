// Ref listing, ref resolution, and the "did you mean" hint.
// Runs entirely offline against a fixture "GitLab" built in the temp directory.
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
  editDistance,
  rankSimilar,
  type RefEntry,
} from "../src/repoStore.js";
import { buildFixture } from "./fixture.js";

// Its own fixture root, so the ref set is just: main, fix/TEST-1, tag v1.0,
// plus a merge-request ref the listing must ignore.
const fixture = buildFixture(path.join(os.tmpdir(), "glmcp-fixture-refs"));

const config: Config = {
  host: pathToFileURL(fixture.root).href,
  token: "",
  cacheDir: path.join(fixture.root, "cache"),
  gitBin: "git",
  fetchMode: "ttl",
  fetchTtlSeconds: 600,
};

const store = new RepoStore(config, new Git({ bin: "git" }));

function ref(name: string, kind: "branch" | "tag" = "branch"): RefEntry {
  return {
    name,
    refname: kind === "branch" ? `refs/heads/${name}` : `refs/tags/${name}`,
    kind,
    commit: "0".repeat(40),
  };
}

describe("list_refs", () => {
  it("lists branches and reports the default branch", async () => {
    const result = await store.listRefs("demo");
    assert.equal(result.project, "demo");
    assert.equal(result.kind, "branches");
    assert.equal(result.defaultBranch, "main");
    assert.deepEqual(
      result.refs.map((entry) => entry.name).sort(),
      ["fix/TEST-1", "main"],
    );
    assert.match(result.refs[0]?.commit ?? "", /^[0-9a-f]{40}$/);
    assert.ok(result.syncedAt instanceof Date, "syncedAt should be a Date");
  });

  it("keeps merge-request refs out of the listing", async () => {
    // A mirror clone copies every ref the server advertises, including
    // `refs/merge-requests/*`, which would otherwise bury the branches anyone
    // actually asks about.
    const result = await store.listRefs("demo", { kind: "all", maxEntries: 5000 });
    assert.ok(
      result.refs.every((entry) => !entry.name.includes("merge-requests")),
      `unexpected ref in ${result.refs.map((entry) => entry.name).join(", ")}`,
    );
    assert.equal(result.total, 3, "expected two branches and one tag");
  });

  it("lists tags, peeled to the commit they point at", async () => {
    const result = await store.listRefs("demo", { kind: "tags" });
    assert.deepEqual(
      result.refs.map((entry) => entry.name),
      ["v1.0"],
    );
    assert.equal(result.refs[0]?.kind, "tag");
    // v1.0 is annotated, so its own object id is a tag object: the reported
    // commit must be the one the tag ultimately points at.
    const main = await store.resolveRef("demo", "main");
    assert.equal(result.refs[0]?.commit, main);
  });

  it("carries the tip commit's subject", async () => {
    const result = await store.listRefs("demo", { kind: "branches", search: "main" });
    assert.match(result.refs[0]?.subject ?? "", /initial/);
  });

  it("filters by a substring of the name", async () => {
    const result = await store.listRefs("demo", { kind: "all", search: "fix/" });
    assert.deepEqual(
      result.refs.map((entry) => entry.name),
      ["fix/TEST-1"],
    );
  });

  it("caps the number of refs and says so", async () => {
    const result = await store.listRefs("demo", { kind: "all", maxEntries: 1 });
    assert.equal(result.refs.length, 1);
    assert.equal(result.total, 3);
    assert.equal(result.truncated, true);
  });

  it("reports no match rather than failing", async () => {
    const result = await store.listRefs("demo", { kind: "all", search: "no-such-thing" });
    assert.deepEqual(result.refs, []);
    assert.equal(result.truncated, false);
  });
});

describe("resolve_ref", () => {
  it("identifies a branch", async () => {
    const found = await store.resolveRefInfo("demo", "fix/TEST-1");
    assert.ok(found, "expected fix/TEST-1 to resolve");
    assert.equal(found.kind, "branch");
    assert.equal(found.refname, "refs/heads/fix/TEST-1");
    assert.match(found.commit, /^[0-9a-f]{40}$/);
  });

  it("identifies a tag", async () => {
    const found = await store.resolveRefInfo("demo", "v1.0");
    assert.ok(found, "expected v1.0 to resolve");
    assert.equal(found.kind, "tag");
    assert.equal(found.refname, "refs/tags/v1.0");
  });

  it("classifies a raw sha as a plain commit", async () => {
    const sha = await store.resolveRef("demo", "main");
    assert.ok(sha);
    const found = await store.resolveRefInfo("demo", sha);
    assert.ok(found, "expected the sha to resolve");
    assert.equal(found.kind, "commit");
    assert.equal(found.refname, undefined);
    assert.equal(found.commit, sha);
  });

  it("reports a ref that does not exist as not found", async () => {
    await assert.rejects(
      () => store.resolveRefInfo("demo", "no/such-branch"),
      (error: unknown) => {
        assert.ok(error instanceof NotFoundError);
        assert.match(error.message, /Ref not found/);
        return true;
      },
    );
  });
});

describe("did you mean", () => {
  it("suggests the near miss for a typo'd branch", async () => {
    const suggestions = await store.suggestRefs("demo", "fix/TEST-2");
    assert.deepEqual(
      suggestions.map((entry) => entry.name),
      ["fix/TEST-1"],
    );
  });

  it("suggests nothing when there is no near miss", async () => {
    assert.deepEqual(await store.suggestRefs("demo", "completely-unrelated"), []);
  });

  it("appends suggestions to the get_file not-found error", async () => {
    await assert.rejects(
      () => store.readFile("demo", "fix/TEST-2", "src/index.tsx"),
      (error: unknown) => {
        assert.ok(error instanceof NotFoundError, `expected NotFoundError, got ${String(error)}`);
        assert.match(error.message, /Ref not found/);
        assert.match(error.message, /Did you mean:\n\s+fix\/TEST-1 \(branch\)/);
        return true;
      },
    );
  });

  it("prefers a name that contains the query over a closer typo", () => {
    // "releaze" is one edit away; "release-1" contains the query but is two.
    const refs = [ref("releaze"), ref("release-1")];
    assert.deepEqual(
      rankSimilar(refs, "release", 2).map((entry) => entry.name),
      ["release-1", "releaze"],
    );
  });

  it("orders by distance when no name contains the query", () => {
    // Neither name contains "v1.9": v1.8 is one edit away, v1.10 is two.
    const refs = [ref("v1.10", "tag"), ref("v1.8", "tag")];
    assert.deepEqual(
      rankSimilar(refs, "v1.9", 2).map((entry) => entry.name),
      ["v1.8", "v1.10"],
    );
  });

  it("measures edit distance", () => {
    assert.equal(editDistance("kitten", "sitting"), 3);
    assert.equal(editDistance("", "abc"), 3);
    assert.equal(editDistance("same", "same"), 0);
    assert.equal(editDistance("fix/TEST-1", "fix/TEST-2"), 1);
  });
});
