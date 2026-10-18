import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import {
  DEFAULT_MAX_ENTRIES,
  HARD_MAX_ENTRIES,
  NotFoundError,
  type RepoStore,
  type TreeListResult,
} from "../repoStore.js";
import {
  NO_PROJECT,
  SYNCED_AT_UNKNOWN,
  errorResult,
  failureMessage,
  refreshFailedNote,
  textResult,
} from "./result.js";

const DEFAULT_MAX_BYTES = 200_000;
const HARD_MAX_BYTES = 20_000_000;

/** Render a tree listing: a provenance header, then one tab-separated row per entry. */
export function formatTree(result: TreeListResult): string {
  const attributes = [
    `project="${result.project}"`,
    `ref="${result.ref}"`,
    `commit="${result.commit}"`,
    `path="${result.path || "/"}"`,
    result.recursive ? 'recursive="true"' : undefined,
    `count="${result.entries.length}"`,
    result.total !== result.entries.length ? `total="${result.total}"` : undefined,
    result.syncedAt ? `synced_at="${result.syncedAt.toISOString()}"` : SYNCED_AT_UNKNOWN,
    result.refreshError ? 'refresh_failed="true"' : undefined,
    result.truncated ? 'truncated="true"' : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");

  const rows = result.entries.map((entry) =>
    [entry.type, entry.size === undefined ? "-" : String(entry.size), entry.path].join("\t"),
  );

  const body = rows.length > 0 ? rows.join("\n") : "(empty)";
  const footer =
    (result.truncated
      ? `\n[truncated: showing ${result.entries.length} of ${result.total} entries]`
      : "") + refreshFailedNote(result.refreshError);

  return `<tree ${attributes}>\n${body}${footer}\n</tree>`;
}

export function registerFileTools(server: McpServer, store: RepoStore, config: Config): void {
  server.registerTool(
    "get_file",
    {
      title: "Read a file at a specific ref",
      description:
        "Return the contents of a file at a given branch, tag, or commit WITHOUT checking it out. " +
        "Use this to inspect files on a branch other than the one currently checked out. " +
        "The repository is mirrored locally on first use and refreshed when it goes stale, or, " +
        "for a project registered with `add_repo`, read from your own clone. The result reports " +
        "the resolved commit and the last sync time. If the copy cannot be refreshed, the " +
        "cached copy answers and the result says the refresh failed.",
      inputSchema: {
        ref: z
          .string()
          .describe("Branch, tag, or commit SHA, e.g. 'develop' or 'fix/PROJ-7608'."),
        path: z
          .string()
          .describe("File path inside the repository, forward slashes, e.g. 'src/index.tsx'."),
        project: z
          .string()
          .optional()
          .describe(
            "GitLab project path, e.g. 'group/subgroup/repo'. Defaults to GITLAB_DEFAULT_PROJECT.",
          ),
        max_bytes: z
          .number()
          .int()
          .positive()
          .max(HARD_MAX_BYTES)
          .optional()
          .describe(`Maximum bytes of content to return (default ${DEFAULT_MAX_BYTES}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ ref, path: filePath, project, max_bytes }) => {
      const target = project?.trim() || config.defaultProject;
      if (!target) {
        return errorResult(NO_PROJECT);
      }

      try {
        const limit = max_bytes ?? DEFAULT_MAX_BYTES;
        const result = await store.readFile(target, ref, filePath, limit);

        if (result.binary) {
          return errorResult(
            `"${result.path}" at "${result.ref}" (${result.commit.slice(0, 12)}) looks binary; refusing to return contents.`,
          );
        }

        const attributes = [
          `project="${result.project}"`,
          `ref="${result.ref}"`,
          `commit="${result.commit}"`,
          `path="${result.path}"`,
          result.syncedAt ? `synced_at="${result.syncedAt.toISOString()}"` : SYNCED_AT_UNKNOWN,
          result.refreshError ? 'refresh_failed="true"' : undefined,
          result.truncated ? 'truncated="true"' : undefined,
        ]
          .filter((value): value is string => value !== undefined)
          .join(" ");

        const body = result.truncated
          ? `${result.content}\n</file>\n[truncated: content exceeded the ${limit} byte limit]`
          : `${result.content}\n</file>`;

        return textResult(
          `<file ${attributes}>\n${body}${refreshFailedNote(result.refreshError)}`,
        );
      } catch (error) {
        if (error instanceof NotFoundError) {
          return errorResult(error.message);
        }
        return errorResult(`Failed to read "${filePath}" at "${ref}".\n${failureMessage(error)}`);
      }
    },
  );

  server.registerTool(
    "list_tree",
    {
      title: "List a directory at a ref",
      description:
        "List the files and subdirectories at a given ref, one level deep by default; set " +
        "`recursive` to walk the whole subtree. Files carry their size in bytes, so you can " +
        "tell a small config from a bundle before reading it. Names are full paths relative to " +
        "the repository root. Everything comes from git, so no file is fetched to answer this. " +
        "If the copy cannot be refreshed, the cached copy answers and the result says the " +
        "refresh failed.",
      inputSchema: {
        ref: z
          .string()
          .describe("Branch, tag, or commit SHA, e.g. 'develop' or 'fix/PROJ-7608'."),
        path: z
          .string()
          .optional()
          .describe(
            "Directory inside the repository, forward slashes, e.g. 'src'. Defaults to the repository root.",
          ),
        recursive: z
          .boolean()
          .optional()
          .describe(
            "List every file in the subtree instead of just the immediate children (files only).",
          ),
        project: z
          .string()
          .optional()
          .describe(
            "GitLab project path, e.g. 'group/subgroup/repo'. Defaults to GITLAB_DEFAULT_PROJECT.",
          ),
        max_entries: z
          .number()
          .int()
          .positive()
          .max(HARD_MAX_ENTRIES)
          .optional()
          .describe(`Maximum entries to return (default ${DEFAULT_MAX_ENTRIES}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ ref, path: dirPath, recursive, project, max_entries }) => {
      const target = project?.trim() || config.defaultProject;
      if (!target) {
        return errorResult(NO_PROJECT);
      }

      try {
        const result = await store.listTree(target, ref, dirPath ?? "", {
          recursive,
          maxEntries: max_entries,
        });
        return textResult(formatTree(result));
      } catch (error) {
        if (error instanceof NotFoundError) {
          return errorResult(error.message);
        }
        return errorResult(
          `Failed to list "${dirPath || "/"}" at "${ref}".\n${failureMessage(error)}`,
        );
      }
    },
  );
}
