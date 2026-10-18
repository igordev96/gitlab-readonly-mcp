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
  /** When the mirror backing this read was last synchronised, if known. */
  syncedAt?: Date;
  /** True when this read triggered a fetch. */
  fetched: boolean;
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

type RefreshReason = "ttl" | "miss";

interface ResolvedRef {
  dir: string;
  ref: string;
  project: string;
  commit?: string;
  fetched: boolean;
}

/**
 * Resolves GitLab projects to a local git view and reads from them.
 *
 * Phase 2a keeps managed bare mirrors only (no local-clone preference yet); that
 * arrives with the repo registry in Phase 2c.
 *
 * Freshness: mirrors are refreshed according to `fetchMode`/`fetchTtlSeconds`,
 * and a ref that is not found locally triggers one extra fetch before giving up.
 * The last sync time is exposed so callers can see how fresh an answer is.
 */
export class RepoStore {
  private readonly syncTimes = new Map<string, number>();
  private readonly fetchChains = new Map<string, Promise<unknown>>();

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

    // `git clone --mirror` does not write FETCH_HEAD, so seed the clock here.
    this.syncTimes.set(clean, Date.now());
    process.stderr.write(`[gitlab-mcp] cloned ${clean}\n`);
    return dir;
  }

  /**
   * Fetch a mirror unconditionally. Because it was created with `--mirror`, a
   * plain fetch updates all refs, prunes deleted ones, and honours force-pushes.
   */
  async syncMirror(project: string): Promise<string> {
    const clean = validateProject(project);
    const dir = await this.ensureMirror(clean);
    await this.execFetch(clean, dir);
    return dir;
  }

  /** Resolve a ref to a commit SHA, or undefined when it does not exist. */
  async resolveRef(project: string, ref: string): Promise<string | undefined> {
    const { commit } = await this.resolveWithFreshness(project, ref);
    return commit;
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

    const { dir, commit, fetched } = await this.resolveWithFreshness(cleanProject, cleanRef);
    if (!commit) {
      throw new NotFoundError(`Ref not found: "${cleanRef}" in ${cleanProject}.`);
    }

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

    const syncMs = await this.lastSyncAt(cleanProject, dir);
    return {
      project: cleanProject,
      ref: cleanRef,
      commit,
      path: cleanPath,
      content: shown.stdout,
      truncated: shown.truncated,
      binary: shown.stdout.includes("\u0000"),
      syncedAt: syncMs === undefined ? undefined : new Date(syncMs),
      fetched,
    };
  }

  // --- internals -----------------------------------------------------------

  /**
   * Ensure the mirror is fresh enough, then resolve the ref. If the ref is not
   * found and we did not just fetch, fetch once more and retry — this is what
   * makes a branch created moments ago appear without a manual sync.
   */
  private async resolveWithFreshness(project: string, ref: string): Promise<ResolvedRef> {
    const cleanProject = validateProject(project);
    const cleanRef = validateRef(ref);
    const dir = await this.ensureMirror(cleanProject);

    const refreshed = await this.refresh(cleanProject, dir, "ttl");
    let commit = await this.revParse(dir, cleanRef);
    let fetched = refreshed;

    if (!commit && !refreshed) {
      fetched = await this.refresh(cleanProject, dir, "miss");
      commit = await this.revParse(dir, cleanRef);
    }

    return { dir, ref: cleanRef, project: cleanProject, commit, fetched };
  }

  private async revParse(dir: string, ref: string): Promise<string | undefined> {
    const result = await this.git.run(
      ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      { gitDir: dir, maxBytes: 4096 },
    );
    if (result.code !== 0) {
      return undefined;
    }
    return result.stdout.trim() || undefined;
  }

  /**
   * Refresh the mirror when policy says it is stale.
   *
   * Serialised per project. The decision is re-checked inside the lock so that
   * callers queued behind an in-flight fetch do not fetch again.
   *
   * @returns true when a fetch actually ran.
   */
  private async refresh(project: string, dir: string, reason: RefreshReason): Promise<boolean> {
    const startedAt = Date.now();
    const ttlMs = this.config.fetchMode === "always" ? 0 : this.config.fetchTtlSeconds * 1000;

    return this.enqueue(project, async () => {
      const last = await this.lastSyncAt(project, dir);
      if (reason === "ttl") {
        if (last !== undefined && Date.now() - last <= ttlMs) {
          return false;
        }
      } else if (last !== undefined && last >= startedAt) {
        // Another caller refreshed while we waited our turn.
        return false;
      }

      await this.execFetch(project, dir);
      return true;
    });
  }

  private async execFetch(project: string, dir: string): Promise<void> {
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
    this.syncTimes.set(project, Date.now());
  }

  /** Serialise work per key (here: per project) without blocking other projects. */
  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = this.fetchChains.get(key) ?? Promise.resolve();
    const run = prior.then(task, task);
    this.fetchChains.set(key, run.then(
      () => undefined,
      () => undefined,
    ));
    return run;
  }

  /**
   * Last known sync time: the newest of the in-memory clock and the mirror's
   * FETCH_HEAD mtime (which survives process restarts).
   */
  private async lastSyncAt(project: string, dir: string): Promise<number | undefined> {
    let fromFile: number | undefined;
    try {
      const stats = await fs.stat(path.join(dir, "FETCH_HEAD"));
      fromFile = stats.mtimeMs;
    } catch {
      fromFile = undefined;
    }

    const fromMemory = this.syncTimes.get(project);
    if (fromMemory === undefined) {
      return fromFile;
    }
    if (fromFile === undefined) {
      return fromMemory;
    }
    return Math.max(fromMemory, fromFile);
  }

  /** Remove the token from any text before it reaches a log or tool result. */
  private redact(value: string): string {
    return this.git.redact(value);
  }
}
