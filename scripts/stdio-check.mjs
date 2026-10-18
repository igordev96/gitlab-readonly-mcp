// Verifies the compiled entry point boots and speaks MCP over stdio,
// spawning it the same way OpenCode does. No network or real token required.
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cache = path.join(os.tmpdir(), "glmcp-startup-check");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(process.cwd(), "dist", "index.js")],
  env: {
    ...process.env,
    GITLAB_HOST: process.env.CHECK_HOST ?? "https://gitlab.example.com",
    GITLAB_TOKEN: "startup-check-dummy-token",
    GITLAB_MCP_CACHE: cache,
    GITLAB_DEFAULT_PROJECT: "group/sub/repo",
  },
  stderr: "pipe",
});

const client = new Client({ name: "startup-check", version: "0.0.0" });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const info = client.getServerVersion();
  console.log("connected:", JSON.stringify(info));
  console.log("tools:", tools.map((t) => t.name).join(", "));
  const getFile = tools.find((t) => t.name === "get_file");
  console.log("get_file args:", Object.keys(getFile?.inputSchema.properties ?? {}).join(", "));
  console.log("STARTUP OK");
  await client.close();
  process.exit(0);
} catch (error) {
  console.error("STARTUP FAILED:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
