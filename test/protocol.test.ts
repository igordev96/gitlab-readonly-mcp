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

  it("exposes get_file", async () => {
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === "get_file"), "get_file is missing");
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
});
