// Rendering the registry listing: the shape the agent actually reads.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { RepoListing } from "../src/repoStore.js";
import { formatRepoList } from "../src/tools/repos.js";

function listing(...repos: RepoListing["repos"]): RepoListing {
  return { repos };
}

describe("formatRepoList", () => {
  it("renders one row per project with its policy and sync time", () => {
    const text = formatRepoList(
      listing({
        project: "group/repo",
        source: "mirror",
        freshnessMode: "ttl",
        freshnessTtlSeconds: 600,
        present: true,
        syncedAt: new Date("2026-10-18T18:08:50.095Z"),
      }),
    );

    assert.match(text, /^<repos count="1">/);
    assert.match(
      text,
      /group\/repo\tsource=mirror\tfreshness=ttl\tttl=600s\tpresent=true\tsynced_at="2026-10-18T18:08:50\.095Z"/,
    );
    assert.match(text, /<\/repos>$/);
  });

  it("says the age is unknown when a project has never synced", () => {
    const text = formatRepoList(
      listing({
        project: "group/repo",
        source: "mirror",
        freshnessMode: "manual",
        freshnessTtlSeconds: 600,
        present: false,
      }),
    );
    assert.match(text, /freshness=manual/);
    assert.match(text, /present=false/);
    assert.match(text, /synced_at="unknown"/);
  });

  it("names the clone a local registration points at", () => {
    const text = formatRepoList(
      listing({
        project: "group/repo",
        source: "local",
        localPath: "C:/work/repo",
        freshnessMode: "ttl",
        freshnessTtlSeconds: 600,
        present: true,
      }),
    );
    assert.match(text, /source=local/);
    assert.match(text, /local_path=C:\/work\/repo/);
  });

  it("says so when nothing is registered", () => {
    assert.match(formatRepoList(listing()), /\(no repositories registered yet\)/);
  });
});
