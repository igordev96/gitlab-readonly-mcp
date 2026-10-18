// Shared result shapes, so every tool succeeds and fails in the same way.
import { GitError } from "../git.js";
import { explainGitError } from "../gitDiagnostics.js";

export type ToolTextResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function textResult(text: string): ToolTextResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(message: string): ToolTextResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** The standard "which repository?" complaint when no project resolves. */
export const NO_PROJECT =
  "No project specified and GITLAB_DEFAULT_PROJECT is not set. Pass a `project` like 'group/subgroup/repo'.";

/**
 * Render a failure for the agent. A git failure carries git's own stderr, which
 * is the difference between "clone failed" and "your token was rejected".
 */
export function failureMessage(error: unknown): string {
  if (error instanceof GitError) {
    return explainGitError(error);
  }
  return error instanceof Error ? error.message : String(error);
}
