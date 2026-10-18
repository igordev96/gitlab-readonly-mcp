import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import type { RepoListing, RepoStore } from "../repoStore.js";
import {
  NO_PROJECT,
  SYNCED_AT_UNKNOWN,
  errorResult,
  failureMessage,
  textResult,
} from "./result.js";

/** Render the registry: a count, then one tab-separated row per project. */
export function formatRepoList(result: RepoListing): string {
  const rows = result.repos.map((repo) =>
    [
      repo.project,
      `source=${repo.source}`,
      `freshness=${repo.freshnessMode}`,
      `ttl=${repo.freshnessTtlSeconds}s`,
      `present=${repo.present}`,
      repo.localPath ? `local_path=${repo.localPath}` : undefined,
      repo.syncedAt ? `synced_at="${repo.syncedAt.toISOString()}"` : SYNCED_AT_UNKNOWN,
    ]
      .filter((cell): cell is string => cell !== undefined)
      .join("\t"),
  );

  const body = rows.length > 0 ? rows.join("\n") : "(no repositories registered yet)";
  return `<repos count="${result.repos.length}">\n${body}\n</repos>`;
}

export function registerRepoTools(server: McpServer, store: RepoStore, config: Config): void {
  server.registerTool(
    "list_repos",
    {
      title: "List known repositories",
      description:
        "List the repositories this server knows about, with the freshness policy applied to " +
        "each and when it last synced successfully. Each row is the project path followed by " +
        "`source`, `freshness` (`ttl`, `always` or `manual`), `ttl`, `present` (whether the " +
        "data is on disk) and `synced_at`, or `unknown` when it has never synced. A project is " +
        "registered the first time it is used. `freshness=manual` means nothing refreshes it " +
        "by itself: use `sync_repo`.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return textResult(formatRepoList(await store.listRepos()));
      } catch (error) {
        return errorResult(`Failed to list repositories.\n${failureMessage(error)}`);
      }
    },
  );

  server.registerTool(
    "sync_repo",
    {
      title: "Fetch a repository now",
      description:
        "Fetch a project's mirror immediately, ignoring its freshness policy — the way to " +
        "refresh a project whose policy is `manual`, and to check for new refs without waiting " +
        "for the TTL. Unlike a read, a failure is reported as an error rather than answered " +
        "from the cached copy, because this call exists to fetch.",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe(
            "GitLab project path, e.g. 'group/subgroup/repo'. Defaults to GITLAB_DEFAULT_PROJECT.",
          ),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ project }) => {
      const target = project?.trim() || config.defaultProject;
      if (!target) {
        return errorResult(NO_PROJECT);
      }

      try {
        const result = await store.syncRepo(target);
        const syncedAt = result.syncedAt ? `"${result.syncedAt.toISOString()}"` : '"unknown"';
        return textResult(`<sync project="${result.project}" synced_at=${syncedAt} />`);
      } catch (error) {
        return errorResult(`Failed to sync "${target}".\n${failureMessage(error)}`);
      }
    },
  );
}
