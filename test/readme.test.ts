// The README hard-codes the current version in its install commands, because
// the release asset's file name carries it. That makes the page a second place
// a version can live — and a stale one installs the *previous* release,
// silently, from a page that looks current.
//
// So the rule the page needs is enforced rather than remembered: every version
// the install commands name is the version `package.json` declares. The front
// page must also keep an install command above the fold, since the whole point
// of the first screen is that a reader can install without scrolling.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const readme = fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8");

/** The version `package.json` declares, which is the version a release tags. */
function declaredVersion(): string {
  const parsed = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof parsed.version !== "string") {
    throw new Error("package.json declares no version");
  }
  return parsed.version;
}

/**
 * Every version the install commands name: the release URL and the file name
 * inside it. A prose mention of a version would not be caught, and should not
 * be — only the commands a reader runs are the ones that can install the wrong
 * thing.
 */
function pinnedVersions(): string[] {
  const found: string[] = [];
  for (const match of readme.matchAll(/releases\/download\/v(\d+\.\d+\.\d+)\//g)) {
    const version = match[1];
    if (version) {
      found.push(version);
    }
  }
  for (const match of readme.matchAll(/gitlab-readonly-mcp-(\d+\.\d+\.\d+)\.tgz/g)) {
    const version = match[1];
    if (version) {
      found.push(version);
    }
  }
  return found;
}

describe("README install instructions", () => {
  it("pin the version package.json declares", () => {
    const declared = declaredVersion();

    const pinned = pinnedVersions();
    assert.ok(pinned.length > 0, "the README names no release to install");

    for (const version of pinned) {
      assert.equal(
        version,
        declared,
        `the README installs v${version}, but package.json says ${declared}`,
      );
    }
  });

  it("keep an install command above the fold", () => {
    const front = readme.split(/\n## /)[0] ?? "";
    assert.match(
      front,
      /npm install -g/,
      "the first screen should carry the install command, before the first heading",
    );
  });
});
