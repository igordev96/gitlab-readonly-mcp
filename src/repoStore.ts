import { promises as fs } from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { Git, GitError } from "./git.js";

const PROJECT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const DEFAULT_FILE_MAX_BYTES = 200_000;

/** Thrown when a ref or file path does not exist (as opposed to a hard failure). */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export interface FileReadResult {
  project: string;
  ref: string;
  commit: string;
  path: string;
  content: string;
  truncated: boolean;
  binary: boolean;
}

/** Trim, drop surrounding slashes, and drop a trailing `.git`. */
export function normalizeProject(project: string): string {
  return project
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "");
}

/** Validate and canonicalise a GitLab project path. Returns the clean value. */
export function validateProject(project: string): string {
  const clean = normalizeProject(project);
  const parts = clean.split("/");
  if (clean.length === 0 || parts.some((segment) => !PROJECT_SEGMENT.test(segment))) {
    throw new Error(`Invalid GitLab project path: ${JSON.stringify(project)}`);
  }
  return clean;
}

/**
 * Guard a ref against argument injection. A value starting with `-` would be
 * interpreted by git as an option, so we reject it outright.
 */
export function validateRef(ref: string): string {
  const value = ref.trim();
  if (!value) {
    throw new Error("ref must not be empty.");
  }
  if (value.startsWith("-")) {
    throw new Error(`ref must not start with "-": ${JSON.stringify(ref)}`);
  }
  if (/[\u0000\n\r]/.test(value)) {
    throw new Error("ref contains illegal characters.");
  }
  return value;
}

/** Guard and normalise a repository-relative file path. */
export function validateRepoPath(filePath: string): string {
  const value = filePath.replace(/\\/g, "/").trim();
  if (!value) {
    throw new Error("path must not be empty.");
  }
  if (value.startsWith("-")) {
    throw new Error(`path must not start with "-": ${JSON.stringify(filePath)}`);
  }
  if (/[\u0000\n\r]/.test(value)) {
    throw new Error("path contains illegal characters.");
  }
  return value.replace(/^\/+/, "");
}

/**
 * Resolves GitLab projects to a local git view and reads from them.
 *
 * Phase 1 keeps managed bare mirrors only (no local-clone preference yet); that
 * arrives with the repo registry in Phase 2.
 */
export class RepoStore {
  constructor(
    private readonly config: Config,
    private readonly git: Git,
  ) {}

  /** Filesystem path of the bare mirror for a project. */
  mirrorPath(project: string): string {
    const clean = validateProject(project);
    const segments = clean.split("/").map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, "_"));
    const last = segments.pop();
    if (!last) {
      throw new Error(`Invalid GitLab project path: ${JSON.stringify(project)}`);
    }
    return path.join(this.config.cacheDir, "mirrors", ...segments, `${last}.git`);
  }

  private async exists(target: string): Promise<boolean> {
    try {
      await fs.stat(target);
      return true;
    } catch {
      return false;
    }
  }

  /** Clone the mirror if it is missing, and return its path. */
  async ensureMirror(project: string): Promise<string> {
    const clean = validateProject(project);
    const dir = this.mirrorPath(clean);
    if (await this.exists(path.join(dir, "HEAD"))) {
      return dir;
    }

    await fs.mkdir(path.dirname(dir), { recursive: true });
    const url = `${this.config.host}/${clean}.git`;
    process.stderr.write(`[gitlab-mcp] cloning ${clean} (first use, this can take a moment) ...\n`);

    const result = await this.git.run(["clone", "--mirror", url, dir]);
    if (result.code !== 0) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw new GitError(
        `Failed to clone ${clean} from ${this.config.host}.`,
        result.code,
        this.redact(result.stderr).trim(),
      );
    }

    process.stderr.write(`[gitlab-mcp] cloned ${clean}\n`);
    return dir;
  }

  /**
   * Fetch the mirror. Because it was created with `--mirror`, a plain fetch
   * updates all refs, prunes deleted ones, and honours force-pushes.
   */
  async syncMirror(project: string): Promise<string> {
    const dir = await this.ensureMirror(project);
    const result = await this.git.run(["fetch", "--prune", "--tags"], {
      gitDir: dir,
      maxBytes: 1024 * 1024,
    });
    if (result.code !== 0) {
      throw new GitError(
        `Failed to fetch ${project}.`,
        result.code,
        this.redact(result.stderr).trim(),
      );
    }
    return dir;
  }

  /** Resolve a ref to a commit SHA, or undefined when it does not exist. */
  async resolveRef(project: string, ref: string): Promise<string | undefined> {
    const cleanRef = validateRef(ref);
    const dir = await this.ensureMirror(project);
    const result = await this.git.run(
      ["rev-parse", "--verify", "--end-of-options", `${cleanRef}^{commit}`],
      { gitDir: dir, maxBytes: 4096 },
    );
    if (result.code !== 0) {
      return undefined;
    }
    const sha = result.stdout.trim();
    return sha || undefined;
  }

  /** Read a file at a ref, without touching any working tree. */
  async readFile(
    project: string,
    ref: string,
    filePath: string,
    maxBytes: number = DEFAULT_FILE_MAX_BYTES,
  ): Promise<FileReadResult> {
    const cleanProject = validateProject(project);
    const cleanRef = validateRef(ref);
    const cleanPath = validateRepoPath(filePath);

    const dir = await this.ensureMirror(cleanProject);

    const resolved = await this.git.run(
      ["rev-parse", "--verify", "--end-of-options", `${cleanRef}^{commit}`],
      { gitDir: dir, maxBytes: 4096 },
    );
    if (resolved.code !== 0) {
      throw new NotFoundError(`Ref not found: "${cleanRef}" in ${cleanProject}.`);
    }
    const commit = resolved.stdout.trim();

    // Resolve by SHA so the path can never be mistaken for a ref, and so the
    // returned provenance is unambiguous.
    const shown = await this.git.run(["show", `${commit}:${cleanPath}`], {
      gitDir: dir,
      maxBytes,
    });
    if (shown.code !== 0) {
      throw new NotFoundError(
        `Path not found: "${cleanPath}" at "${cleanRef}" in ${cleanProject}.`,
      );
    }

    return {
      project: cleanProject,
      ref: cleanRef,
      commit,
      path: cleanPath,
      content: shown.stdout,
      truncated: shown.truncated,
      binary: shown.stdout.includes("\u0000"),
    };
  }

  /** Remove the token from any text before it reaches a log or tool result. */
  private redact(value: string): string {
    const token = this.config.token;
    if (!token) {
      return value;
    }
    return value.split(token).join("***");
  }
}
