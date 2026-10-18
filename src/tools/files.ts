import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { GitError } from "../git.js";
import { explainGitError } from "../gitDiagnostics.js";
import { NotFoundError, type RepoStore } from "../repoStore.js";

const DEFAULT_MAX_BYTES = 200_000;
const HARD_MAX_BYTES = 20_000_000;

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function registerFileTools(server: McpServer, store: RepoStore, config: Config): void {
  server.registerTool(
    "get_file",
    {
      title: "Read a file at a specific ref",
      description:
        "Return the contents of a file at a given branch, tag, or commit WITHOUT checking it out. " +
        "Use this to inspect files on a branch other than the one currently checked out. " +
        "The repository is mirrored locally on first use and refreshed when it goes stale; " +
        "the result reports the resolved commit and the mirror's last sync time.",
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
        return errorResult(
          "No project specified and GITLAB_DEFAULT_PROJECT is not set. Pass a `project` like 'group/subgroup/repo'.",
        );
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
          result.syncedAt ? `synced_at="${result.syncedAt.toISOString()}"` : undefined,
          result.truncated ? 'truncated="true"' : undefined,
        ]
          .filter((value): value is string => value !== undefined)
          .join(" ");

        const body = result.truncated
          ? `${result.content}\n</file>\n[truncated: content exceeded the ${limit} byte limit]`
          : `${result.content}\n</file>`;

        return { content: [{ type: "text" as const, text: `<file ${attributes}>\n${body}` }] };
      } catch (error) {
        if (error instanceof NotFoundError) {
          return errorResult(error.message);
        }
        // A git failure carries git's own stderr, which is the difference
        // between "clone failed" and "your token was rejected".
        if (error instanceof GitError) {
          return errorResult(
            `Failed to read "${filePath}" at "${ref}".\n${explainGitError(error)}`,
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(`Failed to read "${filePath}" at "${ref}": ${message}`);
      }
    },
  );
}
