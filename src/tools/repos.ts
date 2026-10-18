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
        "`source` (`mirror` or `local`), `freshness` (`ttl`, `always` or `manual`), `ttl`, " +
        "`present` (whether the data is on disk), `local_path` for a local clone, and " +
        "`synced_at`, or `unknown` when it has never synced. A mirror-backed project is " +
        "registered the first time it is used; `add_repo` registers one before that, and is " +
        "also how a project is pointed at an existing local clone. `freshness=manual` means " +
        "nothing refreshes it by itself: use `sync_repo`.",
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
    "add_repo",
    {
      title: "Register a repository",
      description:
        "Register a project with this server. With `local_path`, reads use that existing clone " +
        "instead of a server-side mirror; the path is checked to be a git repository here, so a " +
        "wrong path is refused now rather than at read time. Without it, the project is " +
        "registered as mirror-backed, which also makes it appear in `list_repos` before it has " +
        "ever been read. Nothing is cloned or fetched: use `sync_repo` for that, or simply read " +
        "the project. A project already registered is updated; its freshness policy is kept.",
      inputSchema: {
        local_path: z
          .string()
          .optional()
          .describe(
            "Path to an existing clone (or bare repository) to read from instead of a mirror.",
          ),
        project: z
          .string()
          .optional()
          .describe(
            "GitLab project path, e.g. 'group/subgroup/repo'. Defaults to GITLAB_DEFAULT_PROJECT.",
          ),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ project, local_path }) => {
      const target = project?.trim() || config.defaultProject;
      if (!target) {
        return errorResult(NO_PROJECT);
      }

      try {
        const result = await store.addRepo(target, local_path?.trim() || undefined);
        const attrs = [
          `project="${result.project}"`,
          `source="${result.source}"`,
          result.localPath ? `local_path="${result.localPath}"` : undefined,
          `updated="${result.updated}"`,
        ]
          .filter((cell): cell is string => cell !== undefined)
          .join(" ");
        const note =
          result.source === "local"
            ? "Reads use that clone; nothing was fetched. A ref it does not have is fetched " +
              "from its own remote on demand."
            : "Nothing was fetched yet: `sync_repo` to fetch now, or the first read will.";
        return textResult(`<repo ${attrs} />\n${note}`);
      } catch (error) {
        return errorResult(`Failed to register "${target}".\n${failureMessage(error)}`);
      }
    },
  );

  server.registerTool(
    "remove_repo",
    {
      title: "Forget a repository",
      description:
        "Forget a project's registration. With `delete_mirror`, the server-side mirror is " +
        "deleted as well — but only a mirror: a registered local clone is never touched, and " +
        "the request is reported as ignored. Forgetting a mirror-backed project is not " +
        "permanent, since the next read registers it again and clones it again if the mirror " +
        "was deleted. Forgetting a *local* registration is how a project goes back to being " +
        "read from a mirror.",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe(
            "GitLab project path, e.g. 'group/subgroup/repo'. Defaults to GITLAB_DEFAULT_PROJECT.",
          ),
        delete_mirror: z
          .boolean()
          .optional()
          .describe(
            "Also delete the cached mirror for this project. Never deletes a local clone. " +
              "Defaults to false, which forgets the project and leaves the data on disk.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ project, delete_mirror }) => {
      const target = project?.trim() || config.defaultProject;
      if (!target) {
        return errorResult(NO_PROJECT);
      }

      try {
        const result = await store.removeRepo(target, { deleteMirror: delete_mirror ?? false });
        const attrs = [
          `project="${result.project}"`,
          `registered="${result.registered}"`,
          result.deletedMirror ? `deleted_mirror="${result.deletedMirror}"` : undefined,
        ]
          .filter((cell): cell is string => cell !== undefined)
          .join(" ");
        const notes: string[] = [];
        if (!result.registered) {
          notes.push("Nothing was registered under that project.");
        } else if (result.keptLocalClone) {
          notes.push(
            "The registered local clone was left alone: only mirrors inside the cache are " +
              "ever deleted.",
          );
        } else {
          notes.push(
            "Reads will use a server-side mirror from now on, registering the project again " +
              "and cloning it if it is not there.",
          );
        }
        return textResult(`<removed ${attrs} />\n${notes.join("\n")}`);
      } catch (error) {
        return errorResult(`Failed to remove "${target}".\n${failureMessage(error)}`);
      }
    },
  );

  server.registerTool(
    "sync_repo",
    {
      title: "Fetch a repository now",
      description:
        "Fetch a project immediately, ignoring its freshness policy — the way to refresh a " +
        "project whose policy is `manual`, and to check for new refs without waiting for the " +
        "TTL. A mirror-backed project is cloned if its mirror is missing; a project registered " +
        "as a local clone is fetched from that clone's own remote. Unlike a read, a failure is " +
        "reported as an error rather than answered from the cached copy, because this call " +
        "exists to fetch.",
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
