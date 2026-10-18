// The registry file: what we write, and what we do when it is not what we wrote.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RepoRegistry, parseRegistry } from "../src/registry.js";

const root = path.join(os.tmpdir(), "glmcp-fixture-registry");

/** A cache directory of its own, so entries cannot leak between tests. */
function freshCache(name: string): string {
  const dir = path.join(root, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("parseRegistry", () => {
  it("reads the entries we write", () => {
    const parsed = parseRegistry(
      JSON.stringify({
        version: 1,
        repos: { "a/b": { source: "mirror", cloneStrategy: "full" } },
      }),
    );
    assert.equal(parsed?.size, 1);
    assert.equal(parsed?.get("a/b")?.source, "mirror");
    assert.equal(parsed?.get("a/b")?.cloneStrategy, "full");
  });

  it("treats an absent cloneStrategy as full", () => {
    const parsed = parseRegistry(JSON.stringify({ repos: { "a/b": { source: "local" } } }));
    assert.equal(parsed?.get("a/b")?.cloneStrategy, "full");
  });

  it("keeps blobless when asked for it", () => {
    const parsed = parseRegistry(
      JSON.stringify({ repos: { "a/b": { source: "mirror", cloneStrategy: "blobless" } } }),
    );
    assert.equal(parsed?.get("a/b")?.cloneStrategy, "blobless");
  });

  it("returns undefined for something that is not JSON", () => {
    assert.equal(parseRegistry("{ not json"), undefined);
  });

  it("returns undefined when the repos map is missing or the wrong shape", () => {
    assert.equal(parseRegistry('{"version":1}'), undefined);
    assert.equal(parseRegistry('{"version":1,"repos":[]}'), undefined);
    assert.equal(parseRegistry("[]"), undefined);
    assert.equal(parseRegistry("null"), undefined);
  });

  it("drops an entry whose source is not one we know", () => {
    const parsed = parseRegistry(
      JSON.stringify({
        repos: {
          "a/b": { source: "mirror", cloneStrategy: "full" },
          "a/c": { source: "carrier-pigeon" },
        },
      }),
    );
    assert.deepEqual([...(parsed?.keys() ?? [])], ["a/b"]);
  });
});

describe("RepoRegistry", () => {
  it("starts empty when there is no file yet", async () => {
    const registry = new RepoRegistry(freshCache("empty"));
    assert.deepEqual(await registry.all(), []);
    assert.equal(await registry.get("a/b"), undefined);
  });

  it("writes a versioned file, reads it back, and leaves no temp file behind", async () => {
    const cache = freshCache("roundtrip");
    const registry = new RepoRegistry(cache);
    await registry.ensure("a/b", { source: "mirror", cloneStrategy: "full" });

    assert.equal(fs.existsSync(`${registry.filePath()}.tmp`), false);
    const onDisk = JSON.parse(fs.readFileSync(registry.filePath(), "utf8"));
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.repos["a/b"].source, "mirror");

    // A later process reads what this one wrote.
    const reader = new RepoRegistry(cache);
    assert.equal((await reader.get("a/b"))?.source, "mirror");
  });

  it("never overwrites an existing registration", async () => {
    const registry = new RepoRegistry(freshCache("no-overwrite"));
    await registry.ensure("a/b", {
      source: "local",
      localPath: path.join("C:", "work", "b"),
      cloneStrategy: "full",
    });
    // The automatic mirror registration must not undo an explicit one.
    await registry.ensure("a/b", { source: "mirror", cloneStrategy: "full" });

    const entry = await registry.get("a/b");
    assert.equal(entry?.source, "local");
    assert.equal(entry?.localPath, path.join("C:", "work", "b"));
  });

  it("orders entries by project, so listings are stable", async () => {
    const registry = new RepoRegistry(freshCache("order"));
    await registry.ensure("z/z", { source: "mirror", cloneStrategy: "full" });
    await registry.ensure("a/a", { source: "mirror", cloneStrategy: "full" });

    assert.deepEqual(
      (await registry.all()).map(({ project }) => project),
      ["a/a", "z/z"],
    );
  });

  it("sets a file it cannot parse aside instead of deleting it, then carries on", async () => {
    const cache = freshCache("corrupt");
    const registry = new RepoRegistry(cache);
    const junk = "{ this is not json";
    fs.writeFileSync(registry.filePath(), junk, "utf8");

    assert.deepEqual(await registry.all(), []);
    assert.equal(
      fs.readFileSync(`${registry.filePath()}.corrupt`, "utf8"),
      junk,
      "the unreadable file must be recoverable, not gone",
    );

    await registry.ensure("a/b", { source: "mirror", cloneStrategy: "full" });
    assert.equal((await new RepoRegistry(cache).get("a/b"))?.source, "mirror");
  });

  it("treats a zero-byte file as unreadable rather than as an empty registry", async () => {
    const cache = freshCache("empty-file");
    const registry = new RepoRegistry(cache);
    fs.writeFileSync(registry.filePath(), "", "utf8");

    assert.deepEqual(await registry.all(), []);
    assert.equal(fs.existsSync(`${registry.filePath()}.corrupt`), true);
  });

  it("replaces an entry through `set`, keeping a policy it did not mention", async () => {
    const registry = new RepoRegistry(freshCache("set"));
    await registry.ensure("a/b", {
      source: "mirror",
      cloneStrategy: "full",
      freshnessMode: "manual",
    });

    await registry.set("a/b", {
      source: "local",
      localPath: path.join("C:", "work", "b"),
      cloneStrategy: "full",
    });

    const entry = await registry.get("a/b");
    assert.equal(entry?.source, "local");
    assert.equal(entry?.localPath, path.join("C:", "work", "b"));
    assert.equal(entry?.freshnessMode, "manual", "a hand-written policy must survive add_repo");
  });

  it("clears localPath when a project goes back to being mirror-backed", async () => {
    const cache = freshCache("set-clears");
    const registry = new RepoRegistry(cache);
    await registry.set("a/b", {
      source: "local",
      localPath: path.join("C:", "work", "b"),
      cloneStrategy: "full",
    });
    await registry.set("a/b", { source: "mirror", localPath: undefined, cloneStrategy: "full" });

    assert.equal((await registry.get("a/b"))?.localPath, undefined);
    const onDisk = JSON.parse(fs.readFileSync(registry.filePath(), "utf8"));
    assert.equal("localPath" in onDisk.repos["a/b"], false, "undefined is not serialised");
  });

  it("removes an entry, and says whether there was one", async () => {
    const registry = new RepoRegistry(freshCache("remove"));
    await registry.ensure("a/b", { source: "mirror", cloneStrategy: "full" });

    assert.equal(await registry.remove("a/b"), true);
    assert.equal(await registry.get("a/b"), undefined);
    assert.equal(await registry.remove("a/b"), false, "forgetting twice is not an error");
  });
});
