import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import type { RepoStore } from "./repoStore.js";
import { registerFileTools } from "./tools/files.js";
import { registerRefTools } from "./tools/refs.js";

export const SERVER_NAME = "gitlab-readonly";
export const SERVER_VERSION = "0.1.0";

export function createServer(config: Config, store: RepoStore): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Read-only access to a self-managed GitLab through local git mirrors. " +
        "Use `list_refs` to discover branches and tags, `resolve_ref` to turn a name " +
        "into a commit, and `get_file` to read a file — all without changing any " +
        "working tree. Repositories are mirrored on first use.",
    },
  );

  registerFileTools(server, store, config);
  registerRefTools(server, store, config);

  return server;
}
