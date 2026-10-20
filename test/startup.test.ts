// Boots the *compiled* entry point over a real stdio transport, the same way
// OpenCode launches it. No network and no real token are needed: the server is
// only asked to list its tools, which never touches a repository.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = path.join(process.cwd(), "dist", "index.js");

describe("compiled entry point", () => {
  it("boots and speaks MCP over stdio", async () => {
    assert.ok(
      fs.existsSync(entry),
      `Not found: ${entry}. Run \`npm run build\` first (or just \`npm test\`, which builds).`,
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: {
        ...process.env,
        GITLAB_HOST: process.env.CHECK_HOST ?? "https://gitlab.example.com",
        GITLAB_TOKEN: "startup-check-dummy-token",
        GITLAB_MCP_CACHE: path.join(os.tmpdir(), "glmcp-startup-check"),
        GITLAB_DEFAULT_PROJECT: "group/sub/repo",
      },
      stderr: "pipe",
    });

    const client = new Client({ name: "startup-check", version: "0.0.0" });
    try {
      await client.connect(transport);
      const info = client.getServerVersion();
      assert.equal(info?.name, "gitlab-readonly");

      // The reported version must come from package.json, so it cannot drift
      // from the tag it was released as.
      const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
        version?: string;
      };
      assert.equal(
        info?.version,
        pkg.version,
        "the server should report exactly the version in package.json",
      );

      const { tools } = await client.listTools();
      assert.ok(
        tools.some((tool) => tool.name === "get_file"),
        `get_file is missing; saw ${tools.map((t) => t.name).join(", ")}`,
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
