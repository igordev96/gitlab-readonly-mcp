import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import {
  DEFAULT_MAX_MATCHES,
  DEFAULT_PICKAXE_LIMIT,
  HARD_MAX_MATCHES,
  NotFoundError,
  type PickaxeResult,
  type RepoStore,
  type SearchResult,
} from "../repoStore.js";
import {
  NO_PROJECT,
  SYNCED_AT_UNKNOWN,
  errorResult,
  failureMessage,
  refreshFailedNote,
  textResult,
} from "./result.js";

/**
 * Longest match line rendered in full. A minified bundle line can be a megabyte,
 * and a tool result is not the place to find that out.
 */
const MATCH_LINE_CHARS = 300;

function sanitize(value: string): string {
  return value.replace(/[\t\r\n]+/g, " ").trim();
}

/** Flatten one matched line to a single readable line, trimming a long one. */
export function matchLine(text: string): string {
  const flat = text.replace(/\t/g, " ").replace(/\r/g, "").trimEnd();
  if (flat.length <= MATCH_LINE_CHARS) {
    return flat;
  }
  const hidden = flat.length - MATCH_LINE_CHARS;
  return `${flat.slice(0, MATCH_LINE_CHARS)}… [+${hidden} characters]`;
}

/** Render a search: a provenance header, then the matches grouped by file. */
export function formatSearch(result: SearchResult): string {
  const attributes = [
    `project="${result.project}"`,
    `ref="${result.ref}"`,
    `commit="${result.commit}"`,
    `query="${sanitize(result.query)}"`,
    result.regex ? 'regex="true"' : undefined,
    result.caseSensitive ? 'case_sensitive="true"' : undefined,
    result.path ? `path="${sanitize(result.path)}"` : undefined,
    `count="${result.matches.length}"`,
    result.total !== result.matches.length ? `total="${result.total}"` : undefined,
    `files="${result.files}"`,
    result.syncedAt ? `synced_at="${result.syncedAt.toISOString()}"` : SYNCED_AT_UNKNOWN,
    result.refreshError ? 'refresh_failed="true"' : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");

  const lines: string[] = [];
  let current: string | undefined;
  for (const match of result.matches) {
    if (match.path !== current) {
      lines.push(match.path);
      current = match.path;
    }
    lines.push(`  ${match.line}: ${matchLine(match.text)}`);
  }
  const body = lines.length > 0 ? lines.join("\n") : "(no matches)";

  let footer = "";
  if (result.outputTruncated) {
    // The byte cap cut the stream, so even the counts are floors, and saying
    // "showing N of N" here would be a lie.
    footer +=
      "\n[truncated: the search output was cut at the size limit, so every count here is a lower bound]";
  } else if (result.truncated) {
    footer += `\n[truncated: showing ${result.matches.length} of ${result.total} matches]`;
  }
  footer += refreshFailedNote(result.refreshError);

  return `<search ${attributes}>\n${body}${footer}\n</search>`;
}

/** Render a pickaxe: one commit per row, most recent first. */
export function formatPickaxe(result: PickaxeResult): string {
  const attributes = [
    `project="${result.project}"`,
    `ref="${result.ref}"`,
    `commit="${result.commit}"`,
    `query="${sanitize(result.query)}"`,
    result.caseSensitive ? 'case_sensitive="true"' : undefined,
    result.path ? `path="${sanitize(result.path)}"` : undefined,
    `count="${result.entries.length}"`,
    result.syncedAt ? `synced_at="${result.syncedAt.toISOString()}"` : SYNCED_AT_UNKNOWN,
    result.refreshError ? 'refresh_failed="true"' : undefined,
    result.truncated ? 'truncated="true"' : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");

  const rows = result.entries.map((entry) =>
    [
      entry.commit.slice(0, 12),
      entry.date ?? "",
      sanitize(entry.author ?? ""),
      sanitize(entry.subject ?? ""),
    ]
      .join("\t")
      .trimEnd(),
  );

  const body = rows.length > 0 ? rows.join("\n") : "(no commits changed how often this appears)";
  const footer =
    (result.truncated
      ? `\n[truncated: showing the most recent ${result.entries.length} commits; raise "limit" for older ones]`
      : "") + refreshFailedNote(result.refreshError);

  return `<pickaxe ${attributes}>\n${body}${footer}\n</pickaxe>`;
}

export function registerSearchTools(server: McpServer, store: RepoStore, config: Config): void {
  server.registerTool(
    "search",
    {
      title: "Search code at a ref",
      description:
        "Search a whole file tree at a branch, tag, or commit — `git grep` — without cloning it into a " +
        "working tree. Matches come back grouped by file: the path, then `line: text` for each hit. " +
        "Matching is literal (`foo|bar` matches that text, not `foo` or `bar`) and case-insensitive " +
        "unless you say otherwise; the ref defaults to the repository's default branch. " +
        "The ref is resolved before searching, so a branch created moments ago is fetched on the miss, " +
        "and the result states the `commit` it searched and `synced_at`. " +
        "`path` is a git pathspec, passed through as git defines it: `src/components/*.tsx` works, but a " +
        "plain pathspec's `**` needs at least one directory level — use `:(glob)src/**/*.tsx` for zero or " +
        "more. A path that matches nothing simply returns no matches. " +
        "Use `pickaxe` to find *when* the text appeared.",
      inputSchema: {
        query: z
          .string()
          .describe("Text to look for, e.g. 'vehicleCount'. Literal unless `regex` is set."),
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
            "Branch, tag, or commit to search, e.g. 'fix/PROJ-7608'. Defaults to the default branch.",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "A git pathspec to limit the search, e.g. 'src/components/*.tsx'. Use ':(glob)src/**/*.tsx' " +
              "for `**` to match zero or more directories, which a plain pathspec does not do.",
          ),
        case_sensitive: z
          .boolean()
          .optional()
          .describe("Match case exactly. Default false: search ignores case."),
        regex: z
          .boolean()
          .optional()
          .describe(
            "Treat `query` as a POSIX extended regex (not PCRE). Default false: match it literally.",
          ),
        max_matches: z
          .number()
          .int()
          .positive()
          .max(HARD_MAX_MATCHES)
          .optional()
          .describe(`Maximum matches to return (default ${DEFAULT_MAX_MATCHES}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, project, ref, path, case_sensitive, regex, max_matches }) => {
      const target = project?.trim() || config.defaultProject;
      if (!target) {
        return errorResult(NO_PROJECT);
      }

      try {
        const result = await store.search(target, query, {
          ref,
          path,
          caseSensitive: case_sensitive,
          regex,
          maxMatches: max_matches,
        });
        return textResult(formatSearch(result));
      } catch (error) {
        // A ref that does not resolve is an answer, not a failure: the message
        // carries the close matches and any failed refresh.
        if (error instanceof NotFoundError) {
          return errorResult(error.message);
        }
        return errorResult(`Failed to search "${query}" in "${target}".\n${failureMessage(error)}`);
      }
    },
  );

  server.registerTool(
    "pickaxe",
    {
      title: "Find commits that changed a string",
      description:
        "Find the commits whose diff changed how often a piece of text appears — `git log -S` — so you " +
        "can answer \"when was this introduced, and by whom?\". Each row is `commit`, `date`, `author`, " +
        "subject, most recent first. The text is matched literally and case-insensitively, as `search` " +
        "matches it, so a pickaxe never reports \"nothing changed\" about text the caller can see. " +
        "Unlike `search` this walks the history of the ref and is therefore slower; pair it with " +
        "`search` to go from \"where is it\" to \"when did it appear\". " +
        "The ref defaults to the repository's default branch, and `path` is a git pathspec.",
      inputSchema: {
        query: z.string().describe("Exact text to follow through history, e.g. 'orderTotals'."),
        project: z
          .string()
          .optional()
          .describe(
            "GitLab project path, e.g. 'group/subgroup/repo'. Defaults to GITLAB_DEFAULT_PROJECT.",
          ),
        ref: z
          .string()
          .optional()
          .describe("Branch, tag, or commit whose history to walk. Defaults to the default branch."),
        path: z
          .string()
          .optional()
          .describe("A git pathspec to limit the search, e.g. 'src/components'."),
        case_sensitive: z
          .boolean()
          .optional()
          .describe("Follow the text case-sensitively. Default false: history is followed by case too."),
        limit: z
          .number()
          .int()
          .positive()
          .max(HARD_MAX_MATCHES)
          .optional()
          .describe(`Maximum commits to return (default ${DEFAULT_PICKAXE_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, project, ref, path, case_sensitive, limit }) => {
      const target = project?.trim() || config.defaultProject;
      if (!target) {
        return errorResult(NO_PROJECT);
      }

      try {
        const result = await store.pickaxe(target, query, {
          ref,
          path,
          caseSensitive: case_sensitive,
          limit,
        });
        return textResult(formatPickaxe(result));
      } catch (error) {
        if (error instanceof NotFoundError) {
          return errorResult(error.message);
        }
        return errorResult(
          `Failed to search history for "${query}" in "${target}".\n${failureMessage(error)}`,
        );
      }
    },
  );
}
