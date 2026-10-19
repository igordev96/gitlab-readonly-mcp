import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import {
  DEFAULT_MAX_ENTRIES,
  HARD_FILE_MAX_BYTES,
  HARD_MAX_ENTRIES,
  NotFoundError,
  normalizeProject,
  type ReadLineRange,
  type RepoStore,
  type TreeListResult,
} from "../repoStore.js";
import { parseGitlabUrl } from "../url.js";
import {
  NO_PROJECT,
  SYNCED_AT_UNKNOWN,
  errorResult,
  failureMessage,
  refreshFailedNote,
  textResult,
} from "./result.js";

const DEFAULT_MAX_BYTES = 200_000;

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

/**
 * The body of a ranged read: the lines that were there, numbered so they line up
 * with the link that asked for them — or a plain statement that the file is
 * shorter than the range.
 */
export function formatRangeBody(lines: ReadLineRange, content: string): string {
  if (lines.availableFrom === undefined || lines.availableTo === undefined) {
    const plural = lines.fileLines === 1 ? "" : "s";
    return `(no lines: the file has ${lines.fileLines} line${plural}, so ${lines.from}-${lines.to} ${lines.fileLines === 1 ? "is" : "are"} past the end)`;
  }
  const body = content
    .split("\n")
    .map((line, index) => `${lines.availableFrom! + index}: ${line}`)
    .join("\n");
  if (lines.availableFrom === lines.from && lines.availableTo === lines.to) {
    return body;
  }
  return (
    `${body}\n` +
    `[lines ${lines.from}-${lines.to} were asked for; the file has ${lines.fileLines}, ` +
    `so ${lines.availableFrom}-${lines.availableTo} came back]`
  );
}

/**
 * Reject a `project` that contradicts the link, *before* anything is resolved:
 * resolving would mirror a project nobody asked for, and then fail.
 */
export function conflictingProject(
  url: string | undefined,
  project: string | undefined,
  config: Config,
): string | undefined {
  if (!url || !project?.trim()) {
    return undefined;
  }
  const named = parseGitlabUrl(url, config.host).project;
  if (normalizeProject(project) === normalizeProject(named)) {
    return undefined;
  }
  return `The URL names "${named}", but project="${project}" was given; pass one or the other.`;
}

export function registerFileTools(server: McpServer, store: RepoStore, config: Config): void {  server.registerTool(
    "get_file",
    {
      title: "Read a file at a specific ref",
      description:
        "Return the contents of a file at a given branch, tag, or commit WITHOUT checking it out. " +
        "Use this to inspect files on a branch other than the one currently checked out. " +
        "Give either `url` — a GitLab web link, whose `#L12-20` line anchor is honoured — or " +
        "both `ref` and `path`. The repository is mirrored locally on first use and refreshed " +
        "when it goes stale, or, for a project registered with `add_repo`, read from your own " +
        "clone. The result reports the resolved commit and the last sync time. If the copy " +
        "cannot be refreshed, the cached copy answers and the result says the refresh failed.",
      inputSchema: {
        ref: z
          .string()
          .optional()
          .describe(
            "Branch, tag, or commit SHA, e.g. 'develop' or 'fix/PROJ-7608'. Required unless `url` is given.",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "File path inside the repository, forward slashes, e.g. 'src/index.tsx'. Required unless `url` is given.",
          ),
        project: z
          .string()
          .optional()
          .describe(
            "GitLab project path, e.g. 'group/subgroup/repo'. Defaults to GITLAB_DEFAULT_PROJECT, or to the URL's project.",
          ),
        url: z
          .string()
          .optional()
          .describe(
            "A GitLab web link, e.g. 'https://gitlab.example.com/group/repo/-/blob/develop/src/index.tsx#L12-20'. " +
              "Replaces ref, path and (usually) project; the host must be GITLAB_HOST.",
          ),
        max_bytes: z
          .number()
          .int()
          .positive()
          .max(HARD_FILE_MAX_BYTES)
          .optional()
          .describe(
            `Maximum bytes of content to return (default ${DEFAULT_MAX_BYTES}). Ignored when a line range is asked for, which needs the whole file.`,
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ ref, path: filePath, project, url, max_bytes }) => {
      const asked = url?.trim() ? url.trim() : undefined;

      try {
        const conflict = conflictingProject(asked, project, config);
        if (conflict) {
          return errorResult(conflict);
        }
        const fromUrl = asked ? await store.resolveUrl(asked) : undefined;
        if (fromUrl && fromUrl.target !== "file") {
          return errorResult(`"${asked}" is a directory link; use list_tree for it.`);
        }
        if (fromUrl && !fromUrl.path) {
          return errorResult(`"${asked}" names a ref but no file path.`);
        }

        const target = (fromUrl?.project ?? project?.trim()) || config.defaultProject;
        if (!target) {
          return errorResult(NO_PROJECT);
        }

        const useRef = fromUrl?.ref ?? ref;
        const usePath = fromUrl?.path ?? filePath;
        if (!useRef || !usePath) {
          return errorResult(
            "Provide `url`, or both `ref` and `path` (path may be omitted with `url`).",
          );
        }

        const limit = max_bytes ?? DEFAULT_MAX_BYTES;
        const result = await store.readFile(target, useRef, usePath, limit, {
          lines: fromUrl?.lines,
        });

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
          result.lines ? `lines="${result.lines.from}-${result.lines.to}"` : undefined,
          result.lines ? `file_lines="${result.lines.fileLines}"` : undefined,
          result.syncedAt ? `synced_at="${result.syncedAt.toISOString()}"` : SYNCED_AT_UNKNOWN,
          result.refreshError ? 'refresh_failed="true"' : undefined,
          result.truncated ? 'truncated="true"' : undefined,
        ]
          .filter((value): value is string => value !== undefined)
          .join(" ");

        const body = result.lines
          ? formatRangeBody(result.lines, result.content)
          : result.content;

        // A ranged read goes to the hard cap rather than the caller's, so the note
        // has to name the limit that actually applied.
        const truncatedNote = result.truncated
          ? result.lines
            ? `[truncated: the file is larger than the ${HARD_FILE_MAX_BYTES} byte read limit, so the range may be incomplete]`
            : `[truncated: content exceeded the ${limit} byte limit]`
          : undefined;

        const footer = [truncatedNote, refreshFailedNote(result.refreshError)]
          .filter((value): value is string => value !== undefined)
          .join("\n");

        return textResult(`<file ${attributes}>\n${body}\n</file>${footer ? `\n${footer}` : ""}`);
      } catch (error) {
        if (error instanceof NotFoundError) {
          return errorResult(error.message);
        }
        if (asked) {
          return errorResult(`Failed to read "${asked}".\n${failureMessage(error)}`);
        }
        return errorResult(
          `Failed to read "${filePath}" at "${ref}".\n${failureMessage(error)}`,
        );
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
        "the repository root. Give either `url` — a GitLab tree link — or `ref` (and optionally " +
        "`path`). Everything comes from git, so no file is fetched to answer this. If the copy " +
        "cannot be refreshed, the cached copy answers and the result says the refresh failed.",
      inputSchema: {
        ref: z
          .string()
          .optional()
          .describe(
            "Branch, tag, or commit SHA, e.g. 'develop' or 'fix/PROJ-7608'. Required unless `url` is given.",
          ),
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
            "GitLab project path, e.g. 'group/subgroup/repo'. Defaults to GITLAB_DEFAULT_PROJECT, or to the URL's project.",
          ),
        url: z
          .string()
          .optional()
          .describe(
            "A GitLab tree link, e.g. 'https://gitlab.example.com/group/repo/-/tree/develop/src'. " +
              "Replaces ref, path and (usually) project; the host must be GITLAB_HOST.",
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
    async ({ ref, path: dirPath, recursive, project, url, max_entries }) => {
      const asked = url?.trim() ? url.trim() : undefined;

      try {
        const conflict = conflictingProject(asked, project, config);
        if (conflict) {
          return errorResult(conflict);
        }
        const fromUrl = asked ? await store.resolveUrl(asked) : undefined;
        if (fromUrl && fromUrl.target === "file") {
          return errorResult(`"${asked}" is a file link; use get_file for it.`);
        }

        const target = (fromUrl?.project ?? project?.trim()) || config.defaultProject;
        if (!target) {
          return errorResult(NO_PROJECT);
        }

        const useRef = fromUrl?.ref ?? ref;
        if (!useRef) {
          return errorResult("Provide `url`, or `ref` (and optionally `path`).");
        }
        const usePath = fromUrl?.path ?? dirPath ?? "";

        const result = await store.listTree(target, useRef, usePath, {
          recursive,
          maxEntries: max_entries,
        });
        return textResult(formatTree(result));
      } catch (error) {
        if (error instanceof NotFoundError) {
          return errorResult(error.message);
        }
        if (asked) {
          return errorResult(`Failed to list "${asked}".\n${failureMessage(error)}`);
        }
        return errorResult(
          `Failed to list "${dirPath || "/"}" at "${ref}".\n${failureMessage(error)}`,
        );
      }
    },
  );
}
