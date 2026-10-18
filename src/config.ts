import os from "node:os";
import path from "node:path";

/** Resolved, validated runtime configuration. */
export interface Config {
  /** GitLab base URL, without a trailing slash (e.g. https://gitlab.example.com). */
  host: string;
  /** Read-only personal or project access token (`read_repository`). */
  token: string;
  /** Root directory for mirrors and the repo registry. */
  cacheDir: string;
  /** Project used when a tool call omits `project`. */
  defaultProject?: string;
  /** Git executable. */
  gitBin: string;
  /** Optional CA bundle path for servers using a private CA. */
  caInfo?: string;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function defaultCacheDir(): string {
  const base =
    process.env.LOCALAPPDATA ??
    process.env.XDG_CACHE_HOME ??
    path.join(os.homedir(), ".cache");
  return path.join(base, "gitlab-readonly-mcp");
}

/**
 * Read configuration from the environment.
 *
 * Throws with a clear, token-free message when required values are missing, so
 * the failure is obvious in the MCP logs.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = stripTrailingSlashes((env.GITLAB_HOST ?? "").trim());
  if (!host) {
    throw new Error(
      "GITLAB_HOST is required (e.g. https://gitlab.example.com).",
    );
  }
  if (!/^https?:\/\//i.test(host)) {
    throw new Error(`GITLAB_HOST must start with http:// or https:// (got "${host}").`);
  }

  const token = (env.GITLAB_TOKEN ?? "").trim();
  if (!token) {
    throw new Error("GITLAB_TOKEN is required (a `read_repository` scoped token).");
  }

  const cacheDir = (env.GITLAB_MCP_CACHE ?? "").trim()
    ? path.resolve((env.GITLAB_MCP_CACHE ?? "").trim())
    : defaultCacheDir();

  const defaultProject = (env.GITLAB_DEFAULT_PROJECT ?? "").trim() || undefined;
  const gitBin = (env.GITLAB_GIT_BIN ?? "git").trim() || "git";
  const caInfo = (env.GITLAB_CA_INFO ?? "").trim() || undefined;

  return { host, token, cacheDir, defaultProject, gitBin, caInfo };
}
