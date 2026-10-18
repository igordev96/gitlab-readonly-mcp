// The MCP surface as a client sees it, over an in-memory transport.
// Runs entirely offline against a fixture "GitLab" built in the temp directory.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { Config } from "../src/config.js";
import { Git } from "../src/git.js";
import { RepoStore } from "../src/repoStore.js";
import { createServer } from "../src/server.js";
import { buildFixture } from "./fixture.js";

const fixture = buildFixture(path.join(os.tmpdir(), "glmcp-fixture-protocol"));

const config: Config = {
  host: pathToFileURL(fixture.root).href,
  token: "",
  cacheDir: path.join(fixture.root, "cache"),
  gitBin: "git",
  fetchMode: "ttl",
  fetchTtlSeconds: 600,
};

/** Just enough of the SDK's result shape to read the text out of it. */
interface TextResult {
  content: Array<{ text?: string }>;
  isError?: boolean;
}

function textOf(result: unknown): string {
  const { content } = result as TextResult;
  return content.map((part) => part.text ?? "").join("\n");
}

let client: Client;

describe("MCP protocol", () => {
  before(async () => {
    const store = new RepoStore(config, new Git({ bin: "git" }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(config, store);
    await server.connect(serverTransport);

    client = new Client({ name: "protocol-test", version: "0.0.0" });
    await client.connect(clientTransport);

    return async () => {
      await client.close();
      await server.close();
    };
  });

  after(async () => {
    await client?.close();
  });

  it("exposes get_file and list_tree", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of ["get_file", "list_tree"]) {
      assert.ok(names.includes(expected), `${expected} is missing; saw ${names.join(", ")}`);
    }
  });

  it("exposes list_refs and resolve_ref", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of ["list_refs", "resolve_ref"]) {
      assert.ok(names.includes(expected), `${expected} is missing; saw ${names.join(", ")}`);
    }
  });

  it("lists refs with provenance", async () => {
    const response = await client.callTool({
      name: "list_refs",
      arguments: { project: "demo", kind: "all" },
    });
    const text = textOf(response);
    assert.match(text, /^<refs /);
    assert.match(text, /default_branch="main"/);
    assert.match(text, /synced_at="\d{4}-\d{2}-\d{2}T/);
    assert.match(text, /branch\t[0-9a-f]{12}\tfix\/TEST-1/);
    assert.match(text, /tag\t[0-9a-f]{12}\tv1\.0/);
  });

  it("filters refs by search", async () => {
    const response = await client.callTool({
      name: "list_refs",
      arguments: { project: "demo", search: "fix/" },
    });
    const text = textOf(response);
    assert.match(text, /count="1"/);
    assert.match(text, /fix\/TEST-1/);
  });

  it("resolves a branch to a full sha", async () => {
    const response = await client.callTool({
      name: "resolve_ref",
      arguments: { project: "demo", ref: "fix/TEST-1" },
    });
    const text = textOf(response);
    assert.match(text, /^<ref /);
    assert.match(text, /kind="branch"/);
    assert.match(text, /refname="refs\/heads\/fix\/TEST-1"/);
    assert.match(text, /commit="[0-9a-f]{40}"/);
  });

  it("suggests near misses for an unknown ref", async () => {
    const response = (await client.callTool({
      name: "resolve_ref",
      arguments: { project: "demo", ref: "fix/TEST-2" },
    })) as unknown as TextResult;

    assert.equal(response.isError, true);
    const text = textOf(response);
    assert.match(text, /Ref not found/);
    assert.match(text, /Did you mean:/);
    assert.match(text, /fix\/TEST-1 \(branch\)/);
  });

  it("returns file contents for a ref that is not checked out", async () => {
    const response = await client.callTool({
      name: "get_file",
      arguments: { project: "demo", ref: "fix/TEST-1", path: "src/index.tsx" },
    });
    const text = textOf(response);
    assert.match(text, /fix\/TEST-1/);
    assert.match(text, /<file /);
    assert.match(text, /commit="/);
  });

  it("reports provenance including synced_at", async () => {
    const response = await client.callTool({
      name: "get_file",
      arguments: { project: "demo", ref: "main", path: "src/index.tsx" },
    });
    assert.match(textOf(response), /synced_at="\d{4}-\d{2}-\d{2}T/);
  });

  it("reports a missing path as an error", async () => {
    const response = (await client.callTool({
      name: "get_file",
      arguments: { project: "demo", ref: "main", path: "src/nope.tsx" },
    })) as unknown as TextResult;
    assert.equal(response.isError, true);
    assert.match(textOf(response), /Path not found/);
  });

  it("reports a missing ref as an error", async () => {
    const response = (await client.callTool({
      name: "get_file",
      arguments: { project: "demo", ref: "ghost", path: "src/index.tsx" },
    })) as unknown as TextResult;
    assert.equal(response.isError, true);
    assert.match(textOf(response), /Ref not found/);
  });

  it("truncates when max_bytes is exceeded", async () => {
    const response = await client.callTool({
      name: "get_file",
      arguments: { project: "demo", ref: "main", path: "src/index.tsx", max_bytes: 5 },
    });
    assert.match(textOf(response), /truncated/);
  });

  it("lists a directory without reading any file", async () => {
    const response = await client.callTool({
      name: "list_tree",
      arguments: { project: "demo", ref: "fix/TEST-1", path: "src" },
    });
    const text = textOf(response);
    assert.match(text, /^<tree /);
    assert.match(text, /project="demo"/);
    assert.match(text, /ref="fix\/TEST-1"/);
    assert.match(text, /path="src"/);
    assert.match(text, /commit="[0-9a-f]{40}"/);
    assert.match(text, /synced_at="\d{4}-\d{2}-\d{2}T/);
    assert.match(text, /^tree\t-\tsrc\/components$/m);
    assert.match(text, /^blob\t\d+\tsrc\/index\.tsx$/m);
    assert.match(text, /<\/tree>$/);
  });

  it("walks a subtree recursively", async () => {
    const response = await client.callTool({
      name: "list_tree",
      arguments: { project: "demo", ref: "fix/TEST-1", recursive: true },
    });
    const text = textOf(response);
    assert.match(text, /recursive="true"/);
    assert.match(text, /^blob\t\d+\tdocs\/readme\.md$/m);
    assert.match(text, /^blob\t\d+\tsrc\/components\/Button\.tsx$/m);
  });

  it("points at get_file when asked to list a file", async () => {
    const response = (await client.callTool({
      name: "list_tree",
      arguments: { project: "demo", ref: "main", path: "src/index.tsx" },
    })) as unknown as TextResult;

    assert.equal(response.isError, true);
    const text = textOf(response);
    assert.match(text, /is a file/);
    assert.match(text, /get_file/);
  });

  it("hands the agent git's own words when a clone fails", async () => {
    // "ghost-project" is not in the fixture server, so the clone fails offline.
    const response = (await client.callTool({
      name: "get_file",
      arguments: { project: "ghost-project", ref: "main", path: "src/index.tsx" },
    })) as unknown as TextResult;

    assert.equal(response.isError, true);
    const text = textOf(response);
    assert.match(text, /Failed to read "src\/index\.tsx" at "main"/);
    assert.match(text, /Failed to clone ghost-project/);
    assert.match(text, /git said: /, "git's stderr must reach the agent, not be swallowed");
    assert.match(text, /does not appear to be a git repository/i);
  });
});
