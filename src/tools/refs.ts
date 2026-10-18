import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import {
  DEFAULT_MAX_ENTRIES,
  HARD_MAX_ENTRIES,
  NotFoundError,
  type RefListResult,
  type RepoStore,
} from "../repoStore.js";
import {
  NO_PROJECT,
  errorResult,
  failureMessage,
  refreshFailedNote,
  textResult,
} from "./result.js";

function sanitize(value: string | undefined): string {
  return (value ?? "").replace(/[\t\r\n]+/g, " ").trim();
}

/** Render a ref listing: a provenance header plus one tab-separated row per ref. */
export function formatRefList(result: RefListResult): string {
  const attributes = [
    `project="${result.project}"`,
    `kind="${result.kind}"`,
    result.defaultBranch ? `default_branch="${result.defaultBranch}"` : undefined,
    `count="${result.refs.length}"`,
    result.total !== result.refs.length ? `total="${result.total}"` : undefined,
    result.syncedAt ? `synced_at="${result.syncedAt.toISOString()}"` : undefined,
    result.refreshError ? 'refresh_failed="true"' : undefined,
    result.truncated ? 'truncated="true"' : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");

  const rows = result.refs.map((entry) =>
    [entry.kind, entry.commit.slice(0, 12), entry.name, sanitize(entry.subject)]
      .join("\t")
      .trimEnd(),
  );

  const body = rows.length > 0 ? rows.join("\n") : "(no refs matched)";
  const footer =
    (result.truncated
      ? `\n[truncated: showing ${result.refs.length} of ${result.total} refs]`
      : "") + refreshFailedNote(result.refreshError);

  return `<refs ${attributes}>\n${body}${footer}\n</refs>`;
}

/**
 * Render a resolved ref as a single, self-describing line, followed by a note
 * when the answer came from the cache because a refresh failed.
 */
export function formatResolvedRef(
  project: string,
  ref: string,
  commit: string,
  kind: string,
  refname: string | undefined,
  syncedAt: Date | undefined,
  refreshError?: string,
): string {
  const attributes = [
    `project="${project}"`,
    `ref="${ref}"`,
    `kind="${kind}"`,
    refname ? `refname="${refname}"` : undefined,
    `commit="${commit}"`,
    syncedAt ? `synced_at="${syncedAt.toISOString()}"` : undefined,
    refreshError ? 'refresh_failed="true"' : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");

  return `<ref ${attributes}>${refreshFailedNote(refreshError)}`;
}

export function registerRefTools(server: McpServer, store: RepoStore, config: Config): void {
  server.registerTool(
    "list_refs",
    {
      title: "List branches and tags",
      description:
        "List branch and/or tag names in a repository, without cloning it into a working tree. " +
        "Each row is `kind`, short commit, name, and the tip commit's subject. " +
        "The list reflects the local mirror as of `synced_at` (by default at most 10 minutes old); " +
        "a ref created since that moment may be missing, because a stale list cannot be detected. " +
        "Use `resolve_ref` to check one specific ref, which does refresh on a miss. " +
        "If the mirror cannot be refreshed, the cached copy answers and the result says the " +
        "refresh failed.",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe(
            "GitLab project path, e.g. 'group/subgroup/repo'. Defaults to GITLAB_DEFAULT_PROJECT.",
          ),
        kind: z
          .enum(["branches", "tags", "all"])
          .optional()
          .describe("Which refs to list: 'branches' (default), 'tags', or 'all'."),
        search: z
          .string()
          .optional()
          .describe("Case-insensitive substring filter on the ref name, e.g. 'PROJ' or 'fix/'."),
        max_refs: z
          .number()
          .int()
          .positive()
          .max(HARD_MAX_ENTRIES)
          .optional()
          .describe(`Maximum refs to return (default ${DEFAULT_MAX_ENTRIES}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ project, kind, search, max_refs }) => {
      const target = project?.trim() || config.defaultProject;
      if (!target) {
        return errorResult(NO_PROJECT);
      }

      try {
        const result = await store.listRefs(target, {
          kind,
          search,
          maxEntries: max_refs,
        });
        return textResult(formatRefList(result));
      } catch (error) {
        return errorResult(`Failed to list refs in "${target}".\n${failureMessage(error)}`);
      }
    },
  );

  server.registerTool(
    "resolve_ref",
    {
      title: "Resolve a ref to a commit",
      description:
        "Resolve a branch, tag, or revision to the full commit SHA it points at, and say what it is " +
        "(`branch`, `tag`, or `commit` for anything else). Use this to confirm a ref exists before " +
        "reading files from it. If the ref is missing, the error lists similar names, and it says " +
        "so when the mirror could not be refreshed, since then a missing ref proves nothing.",
      inputSchema: {
        ref: z
          .string()
          .describe("Branch, tag, or commit SHA, e.g. 'develop' or 'fix/PROJ-7608'."),
        project: z
          .string()
          .optional()
          .describe(
            "GitLab project path, e.g. 'group/subgroup/repo'. Defaults to GITLAB_DEFAULT_PROJECT.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ ref, project }) => {
      const target = project?.trim() || config.defaultProject;
      if (!target) {
        return errorResult(NO_PROJECT);
      }

      try {
        const found = await store.resolveRefInfo(target, ref);
        return textResult(
          formatResolvedRef(
            found.project,
            found.ref,
            found.commit,
            found.kind,
            found.refname,
            found.syncedAt,
            found.refreshError,
          ),
        );
      } catch (error) {
        // A ref that does not resolve is an answer, not a failure: the message
        // carries the close matches and, when relevant, the failed refresh.
        if (error instanceof NotFoundError) {
          return errorResult(error.message);
        }
        return errorResult(`Failed to resolve "${ref}" in "${target}".\n${failureMessage(error)}`);
      }
    },
  );
}
