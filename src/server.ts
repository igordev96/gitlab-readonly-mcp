import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import type { RepoStore } from "./repoStore.js";
import { registerFileTools } from "./tools/files.js";
import { registerHistoryTools } from "./tools/history.js";
import { registerRefTools } from "./tools/refs.js";
import { registerRepoTools } from "./tools/repos.js";
import { registerSearchTools } from "./tools/search.js";
import { registerUrlTools } from "./tools/url.js";

export const SERVER_NAME = "gitlab-readonly";

/**
 * The version reported to clients, read from `package.json` rather than
 * duplicated here.
 *
 * The rule is that the reported version equals the newest tag, and
 * `package.json` is what `npm version` bumps, so it is the single source of
 * truth. Hand-copying it into this file is how it previously drifted.
 *
 * Both `src/` (under `tsx`) and `dist/` sit one level below the package root,
 * so the same relative path resolves in either.
 */
export const SERVER_VERSION: string =
  (createRequire(import.meta.url)("../package.json") as { version?: string }).version ?? "0.0.0";

export function createServer(config: Config, store: RepoStore): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Read-only access to a self-managed GitLab through local git mirrors, or " +
        "through your own clones when a project is registered with `add_repo`. " +
        "Use `list_refs` to discover branches and tags, `resolve_ref` to turn a name " +
        "into a commit, `list_tree` to browse a directory, and `get_file` to read a " +
        "file — all without changing any working tree. `search` greps a whole tree at " +
        "any ref, and `pickaxe` says when a piece of text appeared. `log` lists " +
        "commits on a ref, and `get_commit` reads one commit and its changed files. " +
        "A GitLab web link " +
        "can be handed to `get_file` or `list_tree` as `url`, or inspected with " +
        "`parse_gitlab_url`. Repositories are " +
        "mirrored on first use; `list_repos` reports what is registered and how fresh " +
        "it is, `sync_repo` fetches one immediately, and `remove_repo` forgets one.",
    },
  );

  registerFileTools(server, store, config);
  registerHistoryTools(server, store, config);
  registerRefTools(server, store, config);
  registerRepoTools(server, store, config);
  registerSearchTools(server, store, config);
  registerUrlTools(server, store);

  return server;
}
