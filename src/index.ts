#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { Git } from "./git.js";
import { RepoStore } from "./repoStore.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const git = new Git({
    bin: config.gitBin,
    token: config.token,
    caInfo: config.caInfo,
  });

  const store = new RepoStore(config, git);
  const server = createServer(config, store);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // stderr only: stdout is reserved for the MCP protocol.
  process.stderr.write(
    `[gitlab-mcp] ready (host=${config.host}, cache=${config.cacheDir}` +
      `${config.defaultProject ? `, default=${config.defaultProject}` : ""})\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[gitlab-mcp] fatal: ${message}\n`);
  process.exit(1);
});
