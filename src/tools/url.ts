import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { NotFoundError, type RepoStore, type ResolvedUrl } from "../repoStore.js";
import {
  SYNCED_AT_UNKNOWN,
  errorResult,
  failureMessage,
  refreshFailedNote,
  textResult,
} from "./result.js";

/**
 * Render a parsed GitLab URL: the pieces a read would take, and — when the link
 * did not resolve cleanly — why, in the same voice as the tools it feeds.
 */
export function formatUrl(result: ResolvedUrl): string {
  const attributes = [
    `url="${result.url}"`,
    `host="${result.host}"`,
    `project="${result.project}"`,
    `target="${result.target}"`,
    `ref="${result.ref}"`,
    `path="${result.path || "/"}"`,
    result.lines ? `lines="${result.lines.from}-${result.lines.to}"` : undefined,
    result.refKind ? `ref_kind="${result.refKind}"` : undefined,
    `ref_confirmed="${result.refConfirmed ? "true" : "false"}"`,
    result.commit ? `commit="${result.commit}"` : undefined,
    result.source ? `source="${result.source}"` : undefined,
    result.source
      ? result.syncedAt
        ? `synced_at="${result.syncedAt.toISOString()}"`
        : SYNCED_AT_UNKNOWN
      : undefined,
    result.refreshError ? 'refresh_failed="true"' : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");

  const notes: string[] = [];
  if (result.source === undefined) {
    notes.push(
      "[not resolved: resolve=false, so the ref was split at the first segment and " +
        "nothing was read from the project]",
    );
  } else if (!result.refConfirmed) {
    notes.push(
      `[no ref of ${result.project} matches the start of this link, so the ref was read ` +
        `as "${result.ref}" and the path may have lost part of it; a read would list close matches]`,
    );
  }
  if (result.target === "file" && !result.path) {
    notes.push("[this names a ref but no file: pass a path, or use list_tree to browse it]");
  }

  const footer = [notes.join("\n"), refreshFailedNote(result.refreshError)]
    .filter((value) => value !== "")
    .join("\n");

  return `<url ${attributes}>\n${footer ? `${footer}\n` : ""}</url>`;
}

export function registerUrlTools(server: McpServer, store: RepoStore): void {
  server.registerTool(
    "parse_gitlab_url",
    {
      title: "Parse a GitLab web URL",
      description:
        "Turn a GitLab web link into the project, ref, path and line range a read needs — " +
        "including a ref that contains slashes, which is resolved against the project's own " +
        "refs. Accepts /-/blob/, /-/raw/, /-/tree/ and /-/blame/ links; commit, merge request " +
        "and other links are refused by name rather than guessed at. The link's host must be " +
        "GITLAB_HOST. Resolving may mirror the project on first use; set `resolve: false` to " +
        "parse offline without touching it. `get_file` and `list_tree` accept a `url` directly, " +
        "so this tool is for inspecting a link, not for reading.",
      inputSchema: {
        url: z
          .string()
          .describe(
            "The GitLab web link, e.g. 'https://gitlab.example.com/group/repo/-/blob/fix/PROJ-7608/src/index.tsx#L12-20'.",
          ),
        resolve: z
          .boolean()
          .optional()
          .describe(
            "Match the link's ref against the project's refs and resolve it to a commit (default true). " +
              "Set false to split the ref at the first segment without touching the project.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ url, resolve }) => {
      try {
        return textResult(formatUrl(await store.resolveUrl(url, { resolve })));
      } catch (error) {
        if (error instanceof NotFoundError) {
          return errorResult(error.message);
        }
        return errorResult(`Failed to parse "${url}".\n${failureMessage(error)}`);
      }
    },
  );
}
