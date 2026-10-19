import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import {
  DEFAULT_FILE_MAX_BYTES,
  DEFAULT_LOG_LIMIT,
  HARD_FILE_MAX_BYTES,
  HARD_LOG_LIMIT,
  NotFoundError,
  type CommitFile,
  type CommitResult,
  type LogResult,
  type RepoStore,
} from "../repoStore.js";
import {
  NO_PROJECT,
  SYNCED_AT_UNKNOWN,
  errorResult,
  failureMessage,
  refreshFailedNote,
  textResult,
} from "./result.js";

/** Flatten a value that belongs on one line of a header or a row. */
function oneLine(value: string): string {
  return value.replace(/[\t\r\n]+/g, " ").trim();
}

/** Render a `log`: one commit per row, most recent first. */
export function formatLog(result: LogResult): string {
  const attributes = [
    `project="${result.project}"`,
    `ref="${oneLine(result.ref)}"`,
    `commit="${result.commit}"`,
    result.path ? `path="${oneLine(result.path)}"` : undefined,
    `count="${result.entries.length}"`,
    result.syncedAt ? `synced_at="${result.syncedAt.toISOString()}"` : SYNCED_AT_UNKNOWN,
    result.refreshError ? 'refresh_failed="true"' : undefined,
    result.truncated ? 'truncated="true"' : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");

  const rows = result.entries.map((entry) => {
    const row = [
      entry.short.slice(0, 12),
      entry.date ?? "",
      oneLine(entry.author ?? ""),
      oneLine(entry.subject ?? ""),
    ]
      .join("\t")
      .trimEnd();
    return entry.merge ? `${row}\t(merge)` : row;
  });

  const body = rows.length > 0 ? rows.join("\n") : "(no commits)";
  let footer = "";
  if (result.outputTruncated) {
    footer +=
      "\n[truncated: the history output was cut at the size limit, so older commits may be missing]";
  } else if (result.truncated) {
    footer += `\n[truncated: showing the most recent ${result.entries.length} commits; raise "limit" for older ones]`;
  }
  footer += refreshFailedNote(result.refreshError);

  return `<log ${attributes}>\n${body}${footer}\n</log>`;
}

/** One changed file: status, path, and line counts (or `binary`). */
function fileRow(file: CommitFile): string {
  const counts = file.binary ? "binary" : `+${file.additions ?? 0} -${file.deletions ?? 0}`;
  const name = file.oldPath === undefined ? file.path : `${file.oldPath} -> ${file.path}`;
  return `${file.status}\t${name}\t${counts}`;
}

/** Render one commit: metadata, message, changed files, optional patch. */
export function formatCommit(result: CommitResult): string {
  const author =
    result.author === undefined
      ? undefined
      : `author="${oneLine(result.author)}${result.authorEmail ? ` <${result.authorEmail}>` : ""}"`;
  const committer =
    result.committer === undefined
      ? undefined
      : `committer="${oneLine(result.committer)}${result.committerEmail ? ` <${result.committerEmail}>` : ""}"`;

  const attributes = [
    `project="${result.project}"`,
    `rev="${oneLine(result.rev)}"`,
    `sha="${result.commit}"`,
    result.parents.length > 0 ? `parents="${result.parents.join(" ")}"` : undefined,
    author,
    result.authoredAt ? `authored_at="${result.authoredAt}"` : undefined,
    committer,
    result.committedAt ? `committed_at="${result.committedAt}"` : undefined,
    `files="${result.files.length}"`,
    `additions="${result.additions}"`,
    `deletions="${result.deletions}"`,
    result.merge ? 'merge="true"' : undefined,
    result.patch !== undefined ? 'patch="true"' : undefined,
    result.patchTruncated ? 'patch_truncated="true"' : undefined,
    result.syncedAt ? `synced_at="${result.syncedAt.toISOString()}"` : SYNCED_AT_UNKNOWN,
    result.refreshError ? 'refresh_failed="true"' : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");

  const lines: string[] = [];
  const message = result.message.trimEnd();
  lines.push(message || "(no message)");

  if (result.merge) {
    // An empty file list without this sentence reads as "changed nothing".
    const parent = result.parents[0]?.slice(0, 12) ?? "?";
    lines.push("");
    lines.push(
      `(merge commit: git shows no diff for a merge by default, so there is no file list. ` +
        `Use compare "${parent}" "${result.commit.slice(0, 12)}" for what it brought in.)`,
    );
  } else {
    lines.push("");
    if (result.files.length > 0) {
      for (const file of result.files) {
        lines.push(fileRow(file));
      }
    } else {
      lines.push("(no files changed)");
    }
  }

  if (result.patch !== undefined) {
    lines.push("");
    lines.push(result.patch.trimEnd());
  }

  let footer = "";
  if (result.filesTruncated) {
    footer += "\n[truncated: the file list was cut at the size limit]";
  }
  if (result.patchTruncated) {
    footer += "\n[truncated: the patch was cut at the byte limit]";
  }
  footer += refreshFailedNote(result.refreshError);

  return `<commit ${attributes}>\n${lines.join("\n")}${footer}\n</commit>`;
}

export function registerHistoryTools(server: McpServer, store: RepoStore, config: Config): void {
  server.registerTool(
    "log",
    {
      title: "List commits at a ref",
      description:
        "List commits on a branch, tag, or commit — `git log` — newest first, without cloning it into " +
        "a working tree. Each row is `commit`, `date`, `author`, subject, and a merge commit carries " +
        "`(merge)`. The ref defaults to the repository's default branch, is resolved before the walk, " +
        "and the result states the `commit` it walked and `synced_at`. " +
        "`path` is a git pathspec, so globs work — and history stops at a rename, because git's " +
        "`--follow` accepts only one path and walks renames backwards; pass the new name or use " +
        "`get_commit` when you need to see the rename itself. " +
        "`limit` bounds the answer; when it hides older commits the result says so rather than " +
        "inventing a total. Use `get_commit` on a row's full sha to see what it changed.",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe(
            "GitLab project path, e.g. 'group/subgroup/repo'. Defaults to GITLAB_DEFAULT_PROJECT.",
          ),
        ref: z
          .string()
          .optional()
          .describe(
            "Branch, tag, or commit whose history to walk, e.g. 'fix/PROJ-7608'. Defaults to the default branch.",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "A git pathspec to limit the walk, e.g. 'src/components/*.tsx'. History stops at a rename: a file's earlier names are not followed.",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(HARD_LOG_LIMIT)
          .optional()
          .describe(
            `Maximum commits to return (default ${DEFAULT_LOG_LIMIT}). A capped answer says so.`,
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ project, ref, path, limit }) => {
      const target = project?.trim() || config.defaultProject;
      if (!target) {
        return errorResult(NO_PROJECT);
      }

      try {
        const result = await store.log(target, { ref, path, limit });
        return textResult(formatLog(result));
      } catch (error) {
        if (error instanceof NotFoundError) {
          return errorResult(error.message);
        }
        return errorResult(`Failed to list history in "${target}".\n${failureMessage(error)}`);
      }
    },
  );

  server.registerTool(
    "get_commit",
    {
      title: "Read one commit",
      description:
        "Read one commit — its sha, parents, author and committer with dates, and full message — then " +
        "the files it changed with git's status letter (`A`, `M`, `D`, `R091 old -> new`) and their " +
        "line counts, or `binary`. `rev` accepts a full or abbreviated sha, or a branch or tag. " +
        "`patch: true` appends the unified diff, capped by `max_bytes`. " +
        "A merge commit reports `merge=\"true\"` and no file list, because git shows no diff for a " +
        "merge by default: compare a parent with the commit to see what it brought in. " +
        "The result states the `commit` it resolved `rev` to and `synced_at`.",
      inputSchema: {
        rev: z
          .string()
          .describe(
            "The commit to read: a full or abbreviated sha, or a branch or tag name that resolves to one.",
          ),
        project: z
          .string()
          .optional()
          .describe(
            "GitLab project path, e.g. 'group/subgroup/repo'. Defaults to GITLAB_DEFAULT_PROJECT.",
          ),
        patch: z
          .boolean()
          .optional()
          .describe(
            "Append the commit's unified diff. Default false: metadata and the file list only.",
          ),
        max_bytes: z
          .number()
          .int()
          .positive()
          .max(HARD_FILE_MAX_BYTES)
          .optional()
          .describe(
            `Byte cap for the patch when \`patch\` is set (default ${DEFAULT_FILE_MAX_BYTES}). A cut patch is marked in the result.`,
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ rev, project, patch, max_bytes }) => {
      const target = project?.trim() || config.defaultProject;
      if (!target) {
        return errorResult(NO_PROJECT);
      }

      try {
        const result = await store.getCommit(target, rev, { patch, maxBytes: max_bytes });
        return textResult(formatCommit(result));
      } catch (error) {
        if (error instanceof NotFoundError) {
          return errorResult(error.message);
        }
        return errorResult(`Failed to read "${rev}" in "${target}".\n${failureMessage(error)}`);
      }
    },
  );
}
