import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import {
  DEFAULT_BLAME_MAX_LINES,
  DEFAULT_COMPARE_MAX_FILES,
  DEFAULT_FILE_MAX_BYTES,
  DEFAULT_LOG_LIMIT,
  HARD_BLAME_MAX_LINES,
  HARD_COMPARE_MAX_FILES,
  HARD_DIFF_CONTEXT,
  HARD_FILE_MAX_BYTES,
  HARD_LOG_LIMIT,
  NotFoundError,
  type BlameResult,
  type CommitFile,
  type CommitResult,
  type CompareResult,
  type DiffFileResult,
  type LogResult,
  type RepoStore,
} from "../repoStore.js";
import type { LineRange } from "../url.js";
import { conflictingProject } from "./files.js";
import {
  NO_PROJECT,
  SYNCED_AT_UNKNOWN,
  errorResult,
  failureMessage,
  refreshFailedNote,
  textResult,
} from "./result.js";
import { matchLine } from "./search.js";
import { linkTargetRefusal } from "./url.js";

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

/**
 * Parse a `lines` spec: `12`, `12-20`, either side optionally `L`-prefixed —
 * the shape a GitLab `#L12-20` anchor uses, without the `#`.
 */
export function parseLineSpec(spec: string): LineRange | undefined {
  const match = /^L?(\d+)(?:-L?(\d+))?$/i.exec(spec.trim());
  if (!match) {
    return undefined;
  }
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < 1) {
    return undefined;
  }
  return from <= to ? { from, to } : { from: to, to: from };
}

/** Render a blame: one row per commit, then the lines it last touched. */
export function formatBlame(result: BlameResult): string {
  const shown = result.groups.reduce((total, group) => total + group.lines.length, 0);
  const attributes = [
    `project="${result.project}"`,
    `ref="${oneLine(result.ref)}"`,
    `commit="${result.commit}"`,
    `path="${oneLine(result.path)}"`,
    result.lines ? `lines="${result.lines.from}-${result.lines.to}"` : undefined,
    `file_lines="${result.fileLines}"`,
    `groups="${result.groups.length}"`,
    `count="${shown}"`,
    `max_lines="${result.maxLines}"`,
    result.syncedAt ? `synced_at="${result.syncedAt.toISOString()}"` : SYNCED_AT_UNKNOWN,
    result.refreshError ? 'refresh_failed="true"' : undefined,
    result.truncated ? 'truncated="true"' : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");

  const rows: string[] = [];
  for (const group of result.groups) {
    const first = group.lines[0]?.line;
    const last = group.lines[group.lines.length - 1]?.line;
    const range = first === undefined ? "?" : first === last ? `${first}` : `${first}-${last}`;
    rows.push(
      [group.commit.slice(0, 12), oneLine(group.author ?? ""), group.date ?? "", range]
        .join("\t")
        .trimEnd(),
    );
    for (const line of group.lines) {
      rows.push(`  ${line.line}: ${matchLine(line.text)}`);
    }
  }

  let body: string;
  if (rows.length > 0) {
    body = rows.join("\n");
  } else if (result.lines && result.lines.availableFrom === undefined) {
    const plural = result.fileLines === 1 ? "" : "s";
    body =
      `(no lines: the file has ${result.fileLines} line${plural}, so ` +
      `${result.lines.from}-${result.lines.to} ${result.fileLines === 1 ? "is" : "are"} past the end)`;
  } else {
    body = "(no lines)";
  }

  let footer = "";
  if (result.outputTruncated) {
    footer +=
      "\n[truncated: the blame output was cut at the size limit, so later lines are missing]";
  } else if (result.truncated) {
    footer += `\n[truncated: showing the first ${shown} lines; raise "max_lines" for more]`;
  }
  if (
    result.lines &&
    result.lines.availableFrom !== undefined &&
    result.lines.availableTo !== undefined &&
    (result.lines.availableFrom !== result.lines.from ||
      result.lines.availableTo !== result.lines.to)
  ) {
    footer +=
      `\n[lines ${result.lines.from}-${result.lines.to} were asked for; the file has ` +
      `${result.fileLines}, so ${result.lines.availableFrom}-${result.lines.availableTo} came back]`;
  }
  footer += refreshFailedNote(result.refreshError);

  return `<blame ${attributes}>\n${body}${footer}\n</blame>`;
}

/**
 * Render a comparison: one row per changed file, never a patch.
 *
 * `merge_base="off"` and `merge_base="none"` are different facts — the first is
 * a two-dot diff the caller asked for, the second a three-dot diff that found
 * no common ancestor — so the header never leaves which one it was to a guess.
 */
export function formatCompare(result: CompareResult): string {
  const base =
    result.mergeBase !== undefined
      ? `merge_base="${result.mergeBase}"`
      : result.mergeBaseMissing
        ? 'merge_base="none"'
        : 'merge_base="off"';
  const attributes = [
    `project="${result.project}"`,
    `from="${oneLine(result.from)}"`,
    `to="${oneLine(result.to)}"`,
    `from_commit="${result.fromCommit}"`,
    `to_commit="${result.toCommit}"`,
    base,
    result.path ? `path="${oneLine(result.path)}"` : undefined,
    `files="${result.files.length}"`,
    `total_files="${result.totalFiles}"`,
    `additions="${result.additions}"`,
    `deletions="${result.deletions}"`,
    `max_files="${result.maxFiles}"`,
    result.syncedAt ? `synced_at="${result.syncedAt.toISOString()}"` : SYNCED_AT_UNKNOWN,
    result.refreshError ? 'refresh_failed="true"' : undefined,
    result.truncated ? 'truncated="true"' : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");

  const rows = result.files.map(fileRow);
  const body = rows.length > 0 ? rows.join("\n") : "(no files changed)";

  let footer = "";
  if (result.outputTruncated) {
    footer +=
      "\n[truncated: the diff output was cut at the size limit, so the file list and the totals are partial]";
  } else if (result.truncated) {
    footer +=
      `\n[truncated: showing the first ${result.files.length} of ${result.totalFiles} changed files; ` +
      `raise "max_files" for more]`;
  }
  if (result.mergeBaseMissing) {
    footer +=
      `\n[no merge base: "${oneLine(result.from)}" and "${oneLine(result.to)}" have unrelated histories, ` +
      `so this is a raw two-dot diff between the two commits]`;
  }
  if (result.path !== undefined) {
    footer +=
      "\n[path is a git pathspec, and it narrows rename detection with it: a renamed file can appear as a delete and an add]";
  }
  footer += refreshFailedNote(result.refreshError);

  return `<compare ${attributes}>\n${body}${footer}\n</compare>`;
}

/** Render one file's patch, verbatim, under its byte cap. */
export function formatDiffFile(result: DiffFileResult): string {
  const attributes = [
    `project="${result.project}"`,
    `path="${oneLine(result.path)}"`,
    `from="${oneLine(result.from)}"`,
    `to="${oneLine(result.to)}"`,
    `from_commit="${result.fromCommit}"`,
    `to_commit="${result.toCommit}"`,
    `context="${result.context}"`,
    `bytes="${Buffer.byteLength(result.patch, "utf8")}"`,
    result.syncedAt ? `synced_at="${result.syncedAt.toISOString()}"` : SYNCED_AT_UNKNOWN,
    result.refreshError ? 'refresh_failed="true"' : undefined,
    result.truncated ? 'truncated="true"' : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");

  const body =
    result.patch.trimEnd() ||
    `(no changes to "${oneLine(result.path)}" between "${oneLine(result.from)}" and "${oneLine(result.to)}")`;
  const footer = result.truncated ? "\n[truncated: the patch was cut at the byte limit]" : "";

  return `<diff ${attributes}>\n${body}${footer}\n</diff>`;
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
        "inventing a total. Use `get_commit` on a row's full sha to see what it changed. " +
        "Give either `url` — a GitLab `/-/commits/<ref>[/<path>]` link, e.g. " +
        "'https://gitlab.example.com/group/repo/-/commits/fix/PROJ-7608/src/index.tsx' — or `ref` " +
        "and `path`; the link's host must be GITLAB_HOST.",
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
        url: z
          .string()
          .optional()
          .describe(
            "A GitLab history link, e.g. 'https://gitlab.example.com/group/repo/-/commits/develop'. Replaces ref and path; the host must be GITLAB_HOST.",
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
    async ({ project, ref, path, url, limit }) => {
      const asked = url?.trim() ? url.trim() : undefined;
      const named = project?.trim() || config.defaultProject;

      try {
        const conflict = conflictingProject(asked, project, config);
        if (conflict) {
          return errorResult(conflict);
        }
        const fromUrl = asked ? await store.resolveUrl(asked) : undefined;
        if (fromUrl) {
          const wrong = linkTargetRefusal(asked!, fromUrl.target, "log");
          if (wrong) {
            return errorResult(wrong);
          }
        }

        const target = fromUrl?.project ?? named;
        if (!target) {
          return errorResult(NO_PROJECT);
        }

        const result = await store.log(target, {
          ref: fromUrl?.ref ?? ref,
          path: fromUrl ? fromUrl.path || undefined : path,
          limit,
        });
        return textResult(formatLog(result));
      } catch (error) {
        if (error instanceof NotFoundError) {
          return errorResult(error.message);
        }
        if (asked) {
          return errorResult(`Failed to list history for "${asked}".\n${failureMessage(error)}`);
        }
        return errorResult(
          `Failed to list history in "${named ?? "the repository"}".\n${failureMessage(error)}`,
        );
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
        'A merge commit reports `merge="true"` and no file list, because git shows no diff for a ' +
        "merge by default: compare a parent with the commit to see what it brought in. " +
        "The result states the `commit` it resolved `rev` to and `synced_at`. " +
        "Give either `url` — a GitLab `/-/commit/<sha>` link — or `rev`; the link's host must be " +
        "GITLAB_HOST.",
      inputSchema: {
        rev: z
          .string()
          .optional()
          .describe(
            "The commit to read: a full or abbreviated sha, or a branch or tag name that resolves to one. Required unless `url` is given.",
          ),
        project: z
          .string()
          .optional()
          .describe(
            "GitLab project path, e.g. 'group/subgroup/repo'. Defaults to GITLAB_DEFAULT_PROJECT.",
          ),
        url: z
          .string()
          .optional()
          .describe(
            "A GitLab commit link, e.g. 'https://gitlab.example.com/group/repo/-/commit/8297d0da'. Replaces rev; the host must be GITLAB_HOST.",
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
    async ({ rev, project, url, patch, max_bytes }) => {
      const asked = url?.trim() ? url.trim() : undefined;
      const named = project?.trim() || config.defaultProject;

      try {
        const conflict = conflictingProject(asked, project, config);
        if (conflict) {
          return errorResult(conflict);
        }
        const fromUrl = asked ? await store.resolveUrl(asked) : undefined;
        if (fromUrl) {
          const wrong = linkTargetRefusal(asked!, fromUrl.target, "commit");
          if (wrong) {
            return errorResult(wrong);
          }
        }

        const target = fromUrl?.project ?? named;
        if (!target) {
          return errorResult(NO_PROJECT);
        }

        // A resolved link already holds the revision it points at; the ref it
        // split out is the fallback that carries an unresolved rev into the
        // store's close-match message rather than a complaint here.
        const useRev = fromUrl ? (fromUrl.commit ?? fromUrl.ref) : rev;
        if (!useRev) {
          return errorResult("Provide `url`, or `rev`.");
        }

        const result = await store.getCommit(target, useRev, { patch, maxBytes: max_bytes });
        return textResult(formatCommit(result));
      } catch (error) {
        if (error instanceof NotFoundError) {
          return errorResult(error.message);
        }
        if (asked) {
          return errorResult(`Failed to read "${asked}".\n${failureMessage(error)}`);
        }
        return errorResult(
          `Failed to read "${rev}" in "${named ?? "the repository"}".\n${failureMessage(error)}`,
        );
      }
    },
  );

  server.registerTool(
    "blame",
    {
      title: "Blame a file at a ref",
      description:
        "Show who last touched each line of a file at a branch, tag, or commit — `git blame --porcelain` " +
        "— without a working tree. Lines are grouped into runs from the same commit: a row is " +
        "`commit`, author, date, line range, then the lines themselves, numbered. " +
        '`lines` narrows the blame to a range (`"118-126"`, or `"118"`), and a range past the end is ' +
        "clamped and reported rather than treated as an error. `max_lines` caps how many lines come back. " +
        "The ref defaults to the repository's default branch, and the result states the `commit` it " +
        "blamed and `synced_at`. A binary file is refused: git blames one, but its lines carry NUL bytes. " +
        "Give either `url` — a GitLab `/-/blame/<ref>/<path>` link, whose `#L12-20` anchor narrows the " +
        "blame — or `ref` and `path`; the link's host must be GITLAB_HOST.",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe(
            "GitLab project path, e.g. 'group/subgroup/repo'. Defaults to GITLAB_DEFAULT_PROJECT.",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "File path from the repository root, e.g. 'src/index.tsx'. Required unless `url` is given.",
          ),
        ref: z
          .string()
          .optional()
          .describe(
            "Branch, tag, or commit to blame at, e.g. 'fix/PROJ-7608'. Defaults to the default branch.",
          ),
        url: z
          .string()
          .optional()
          .describe(
            "A GitLab file link to blame, e.g. 'https://gitlab.example.com/group/repo/-/blame/develop/src/index.tsx#L12-20'. Replaces ref, path and lines; the host must be GITLAB_HOST.",
          ),
        lines: z
          .string()
          .optional()
          .describe(
            "Restrict the blame to a line range: '118' or '118-126' (an `L` prefix is accepted, as in a `#L118-126` link). A `url` with an anchor wins over this.",
          ),
        max_lines: z
          .number()
          .int()
          .positive()
          .max(HARD_BLAME_MAX_LINES)
          .optional()
          .describe(
            `Maximum blamed lines to return (default ${DEFAULT_BLAME_MAX_LINES}). A capped answer says so.`,
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ project, path: filePath, ref, url, lines, max_lines }) => {
      const asked = url?.trim() ? url.trim() : undefined;
      const named = project?.trim() || config.defaultProject;

      try {
        const conflict = conflictingProject(asked, project, config);
        if (conflict) {
          return errorResult(conflict);
        }
        const fromUrl = asked ? await store.resolveUrl(asked) : undefined;
        if (fromUrl) {
          const wrong = linkTargetRefusal(asked!, fromUrl.target, "file");
          if (wrong) {
            return errorResult(wrong);
          }
          if (!fromUrl.path) {
            return errorResult(`"${asked}" names a ref but no file path.`);
          }
        }

        const target = fromUrl?.project ?? named;
        if (!target) {
          return errorResult(NO_PROJECT);
        }

        const usePath = fromUrl?.path ?? filePath;
        if (!usePath) {
          return errorResult("Provide `url`, or both `ref` and `path`.");
        }

        // The link's anchor is the narrower instruction when it has one; the
        // `lines` parameter is the fallback for a plain ref-and-path call.
        let range: LineRange | undefined = fromUrl?.lines;
        if (!range && lines !== undefined && lines.trim() !== "") {
          range = parseLineSpec(lines);
          if (!range) {
            return errorResult(
              `lines must look like "12" or "12-20" (got ${JSON.stringify(lines)}).`,
            );
          }
        }

        const result = await store.blame(target, usePath, {
          ref: fromUrl?.ref ?? ref,
          lines: range,
          maxLines: max_lines,
        });
        if (result.binary) {
          return errorResult(
            `"${result.path}" at "${result.ref}" (${result.commit.slice(0, 12)}) looks binary; refusing to return contents.`,
          );
        }
        return textResult(formatBlame(result));
      } catch (error) {
        if (error instanceof NotFoundError) {
          return errorResult(error.message);
        }
        if (asked) {
          return errorResult(`Failed to blame "${asked}".\n${failureMessage(error)}`);
        }
        return errorResult(
          `Failed to blame "${filePath}" in "${named ?? "the repository"}".\n${failureMessage(error)}`,
        );
      }
    },
  );

  server.registerTool(
    "compare",
    {
      title: "Compare two refs",
      description:
        "Summarise what changed on `to` since it split from `from` — `git diff <merge-base> <to>` — as one row " +
        "per file: git's status letter (`A`, `M`, `D`, `R091 old -> new`) and ± counts, or `binary`. The " +
        "`merge_base` is printed, so which diff ran is never hidden; `merge_base: false` asks for the raw two-dot " +
        'diff instead, and when the two refs share no history the two-dot diff runs with `merge_base="none"`. ' +
        "This never returns a patch — a branch diff is unbounded — so the file list is capped by `max_files` and a " +
        "capped answer says so. Use `diff_file` for one file's patch, passing a printed `merge_base` as `from` for " +
        "the branch view of it. `path` is a git pathspec, and it narrows rename detection with it: a rename can " +
        "then appear as a delete and an add. Both refs are resolved before the diff and both commits are stated in " +
        "the result, with `synced_at`.",
      inputSchema: {
        from: z
          .string()
          .describe(
            "The ref to compare from — what the split is measured from, e.g. 'develop' or a commit sha.",
          ),
        to: z
          .string()
          .describe(
            "The ref to compare to — whose changes are summarised, e.g. 'fix/PROJ-7608'.",
          ),
        project: z
          .string()
          .optional()
          .describe(
            "GitLab project path, e.g. 'group/subgroup/repo'. Defaults to GITLAB_DEFAULT_PROJECT.",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "A git pathspec to narrow the comparison, e.g. 'src/'. Note that it narrows rename detection too.",
          ),
        merge_base: z
          .boolean()
          .optional()
          .describe(
            "Diff from the merge base of the two refs (default true). Set false for the raw two-dot diff — 'what would applying this do'.",
          ),
        max_files: z
          .number()
          .int()
          .positive()
          .max(HARD_COMPARE_MAX_FILES)
          .optional()
          .describe(
            `Maximum changed files to list (default ${DEFAULT_COMPARE_MAX_FILES}). Totals still cover every file; a capped answer says so.`,
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ from, to, project, path, merge_base, max_files }) => {
      const target = project?.trim() || config.defaultProject;
      if (!target) {
        return errorResult(NO_PROJECT);
      }
      if (from.trim() === "" || to.trim() === "") {
        return errorResult('compare needs both a "from" and a "to" ref.');
      }

      try {
        const result = await store.compare(target, from, to, {
          path,
          mergeBase: merge_base,
          maxFiles: max_files,
        });
        return textResult(formatCompare(result));
      } catch (error) {
        if (error instanceof NotFoundError) {
          return errorResult(error.message);
        }
        return errorResult(
          `Failed to compare "${from}" and "${to}" in "${target}".\n${failureMessage(error)}`,
        );
      }
    },
  );

  server.registerTool(
    "diff_file",
    {
      title: "Diff one file between two refs",
      description:
        "The unified diff of one file between two refs — `git diff -M <from> <to> -- <path>` — without a working " +
        "tree. The caller names the file and the diff is scoped before git runs, so nothing is found by parsing a " +
        "patch header. `context` sets the lines shown around each hunk (default 3, 0-10) and `max_bytes` caps the " +
        "diff. Scoping by path narrows rename detection, so a renamed file is read as an added (or deleted) file. " +
        "The two refs are a raw two-dot diff: pass a `merge_base` printed by `compare` as `from` for the " +
        "branch view of one file. A file that is unchanged between the refs yields no diff, and one absent from " +
        'both is reported as not found. A binary file is refused: git has only a "Binary files … differ" line ' +
        "for it, which is not a patch.",
      inputSchema: {
        path: z.string().describe("File path from the repository root, e.g. 'src/index.tsx'."),
        from: z.string().describe("The ref to diff from, e.g. 'develop' or a commit sha."),
        to: z.string().describe("The ref to diff to, e.g. 'fix/PROJ-7608'."),
        project: z
          .string()
          .optional()
          .describe(
            "GitLab project path, e.g. 'group/subgroup/repo'. Defaults to GITLAB_DEFAULT_PROJECT.",
          ),
        context: z
          .number()
          .int()
          .min(0)
          .max(HARD_DIFF_CONTEXT)
          .optional()
          .describe(
            `Lines of context on each side of a hunk (default 3, at most ${HARD_DIFF_CONTEXT}). Use 0 for the fewest lines.`,
          ),
        max_bytes: z
          .number()
          .int()
          .positive()
          .max(HARD_FILE_MAX_BYTES)
          .optional()
          .describe(
            `Byte cap for the patch (default ${DEFAULT_FILE_MAX_BYTES}). A cut patch is marked in the result.`,
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path, from, to, project, context, max_bytes }) => {
      const target = project?.trim() || config.defaultProject;
      if (!target) {
        return errorResult(NO_PROJECT);
      }
      if (from.trim() === "" || to.trim() === "") {
        return errorResult('diff_file needs both a "from" and a "to" ref.');
      }

      try {
        const result = await store.diffFile(target, path, from, to, {
          context,
          maxBytes: max_bytes,
        });
        if (result.binary) {
          return errorResult(
            `"${result.path}" between "${result.from}" and "${result.to}" looks binary; refusing to return contents.`,
          );
        }
        return textResult(formatDiffFile(result));
      } catch (error) {
        if (error instanceof NotFoundError) {
          return errorResult(error.message);
        }
        return errorResult(`Failed to diff "${path}" in "${target}".\n${failureMessage(error)}`);
      }
    },
  );
}
