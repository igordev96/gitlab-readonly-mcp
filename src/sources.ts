// Where a project's git data lives, how it is obtained, and when it was last
// synced: mirror paths, clone, fetch, the sync clock and the per-project lock.
//
// Deliberately free of *policy*. When a fetch is due, whether it is allowed at
// all, and what a project is registered as are decided in `RepoStore`; this
// module knows only how to do the thing once that has been decided. The split is
// what keeps a rule like `manual` from being re-implemented in three places and
// drifting apart.
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Config } from "./config.js";
import { Git, GitError } from "./git.js";

export const SYNC_STAMP_FILE = "mcp-last-sync";

/** A place a project's history can be read from. */
export interface GitSource {
  kind: "mirror" | "local";
  /** Passed to git as `--git-dir` for object reads; never modified by a read. */
  gitDir: string;
  /**
   * For a local clone, the checkout that owns it. A fetch runs here so that git
   * finds the repository's own remote configuration; reads do not need it.
   */
  workDir?: string;
  /**
   * For a local clone, the remote to fetch from and the namespace its branches
   * live under when they are not checked out. Absent for a mirror, and for a
   * clone that has no remote — which is why a miss there cannot be fetched.
   */
  remote?: string;
}

export class SourceManager {
  private readonly syncTimes = new Map<string, number>();
  private readonly chains = new Map<string, Promise<unknown>>();

  /** Appended to every "this registered clone is unusable" message. */
  private readonly localFixHint =
    " Register it again with `add_repo`, or `remove_repo` it to fall back to a mirror.";

  constructor(
    private readonly config: Config,
    private readonly git: Git,
  ) {}

  /**
   * Filesystem path of the bare mirror for a project.
   *
   * Assumes an already-validated project path: `RepoStore` is the one place that
   * validates, so that the error a caller sees does not depend on which layer
   * noticed.
   */
  mirrorPath(project: string): string {
    const segments = project.split("/").map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, "_"));
    const last = segments.pop();
    if (!last) {
      throw new Error(`Invalid GitLab project path: ${JSON.stringify(project)}`);
    }
    return path.join(this.config.cacheDir, "mirrors", ...segments, `${last}.git`);
  }

  async exists(target: string): Promise<boolean> {
    try {
      await fs.stat(target);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clone a bare mirror of the project into `dir`.
   *
   * Throws `GitError` carrying git's own stderr when the clone fails, and removes
   * the half-built directory first, so a failed clone is never mistaken for a
   * usable mirror.
   */
  async cloneMirror(project: string, dir: string): Promise<void> {
    await fs.mkdir(path.dirname(dir), { recursive: true });
    const url = `${this.config.host}/${project}.git`;
    process.stderr.write(
      `[gitlab-mcp] cloning ${project} (first use, this can take a moment) ...\n`,
    );

    const result = await this.git.run(["clone", "--mirror", url, dir]);
    if (result.code !== 0) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw new GitError(
        `Failed to clone ${project} from ${this.config.host}.`,
        result.code,
        this.redact(result.stderr).trim(),
      );
    }

    // A clone is itself a sync: record it, so the first read does not fetch again.
    await this.recordSync(dir);
    process.stderr.write(`[gitlab-mcp] cloned ${project}\n`);
  }

  /**
   * Fetch a source, updating all refs and pruning deleted ones.
   *
   * A local source is fetched by name from its detected remote, never an assumed
   * `origin`, and with its checkout as the working directory, which is how git
   * finds that repository's own remote configuration. Nothing is written to the
   * working tree either way.
   *
   * Throws on failure: whether a failed fetch is worth reporting or worth
   * serving the cache from is the caller's decision, not this module's.
   */
  async fetch(project: string, source: GitSource): Promise<void> {
    let remote: string | undefined;
    if (source.kind === "local") {
      remote = source.remote ?? (await this.remoteName(source.workDir ?? source.gitDir));
      if (!remote) {
        throw new GitError(
          `Failed to fetch ${project}: the registered clone at ${
            source.workDir ?? source.gitDir
          } has no remote to fetch from.`,
          null,
          "",
        );
      }
    }

    const args = remote ? ["fetch", "--prune", "--tags", remote] : ["fetch", "--prune", "--tags"];
    const result = await this.git.run(args, {
      gitDir: source.gitDir,
      cwd: source.workDir,
      maxBytes: 1024 * 1024,
    });
    if (result.code !== 0) {
      throw new GitError(
        `Failed to fetch ${project}.`,
        result.code,
        this.redact(result.stderr).trim(),
      );
    }
    // Only a fetch that got this far counts as a sync; a failure throws above.
    await this.recordSync(source.gitDir);
  }

  /**
   * Resolve a registered local path to a source, or say precisely what is wrong
   * with it.
   *
   * Both a normal clone and a bare repository are accepted: a clone is read and
   * fetched through the git directory git reports (which is what makes linked
   * worktrees work, where `.git` is a file rather than a directory), and a bare
   * repository is its own git directory.
   */
  async localSource(project: string, localPath: string): Promise<GitSource> {
    const target = path.resolve(localPath);
    if (!(await this.exists(target))) {
      throw new Error(
        `${project} is registered as the local clone ${target}, which does not exist.` +
          this.localFixHint,
      );
    }

    const bare = await this.git.run(["rev-parse", "--is-bare-repository"], {
      cwd: target,
      maxBytes: 64 * 1024,
    });
    if (bare.code !== 0) {
      throw new Error(
        `${project} is registered as the local clone ${target}, which is not a git repository.` +
          this.localFixHint,
      );
    }
    if (bare.stdout.trim() === "true") {
      return { kind: "local", gitDir: target, remote: await this.remoteName(target) };
    }

    const [gitDir, top] = await Promise.all([
      this.git.run(["rev-parse", "--absolute-git-dir"], { cwd: target, maxBytes: 64 * 1024 }),
      this.git.run(["rev-parse", "--show-toplevel"], { cwd: target, maxBytes: 64 * 1024 }),
    ]);
    if (gitDir.code !== 0 || top.code !== 0) {
      throw new Error(
        `${project} is registered as the local clone ${target}, which is not a usable git repository.` +
          this.localFixHint,
      );
    }

    const workDir = top.stdout.trim() || target;
    return {
      kind: "local",
      gitDir: gitDir.stdout.trim(),
      workDir,
      remote: await this.remoteName(workDir),
    };
  }

  /** Whether a path holds a usable git repository, without throwing. */
  async isRepo(target: string): Promise<boolean> {
    if (!(await this.exists(target))) {
      return false;
    }
    const result = await this.git.run(["rev-parse", "--git-dir"], {
      cwd: target,
      maxBytes: 64 * 1024,
    });
    return result.code === 0;
  }

  /**
   * The remote to fetch a local source from: `origin` when the repository has
   * one, otherwise the first remote it does have. Never assumed, because a clone
   * is not obliged to call anything `origin`.
   */
  async remoteName(target: string): Promise<string | undefined> {
    const result = await this.git.run(["remote"], { cwd: target, maxBytes: 64 * 1024 });
    if (result.code !== 0) {
      return undefined;
    }
    const remotes = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (remotes.includes("origin")) {
      return "origin";
    }
    return remotes[0];
  }

  /**
   * Delete a mirror, and only a mirror: the path is checked to sit inside the
   * cache's own `mirrors` tree first, so a bug elsewhere cannot turn this into a
   * delete of something the user owns.
   */
  async removeMirror(project: string, dir: string): Promise<void> {
    const root = path.resolve(this.config.cacheDir, "mirrors");
    const target = path.resolve(dir);
    if (target === root || !target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Refusing to delete ${target}: it is outside the mirror cache at ${root}.`);
    }
    if (!(await this.exists(target))) {
      return;
    }
    await fs.rm(target, { recursive: true, force: true });
    process.stderr.write(`[gitlab-mcp] removed the mirror for ${project}\n`);
  }

  /** Serialise work per key (here: per source) without blocking other sources. */
  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(key) ?? Promise.resolve();
    const run = prior.then(task, task);
    this.chains.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /**
   * Record a successful sync, in memory and on disk.
   *
   * The disk write is best-effort: a source whose stamp cannot be written stays
   * usable, it is merely treated as never-synced and fetched again next time.
   */
  async recordSync(gitDir: string, at = Date.now()): Promise<void> {
    this.syncTimes.set(gitDir, at);
    await fs.writeFile(this.stampPath(gitDir), `${at}\n`, "utf8").catch(() => undefined);
  }

  /**
   * Last known sync time: the newest of the in-memory clock and the source's
   * sync stamp. Unlike git's own `FETCH_HEAD`, the stamp is written only after a
   * fetch succeeds, so it survives a restart without a failure ever advancing it.
   */
  async lastSyncAt(gitDir: string): Promise<number | undefined> {
    let fromFile: number | undefined;
    try {
      const parsed = Number((await fs.readFile(this.stampPath(gitDir), "utf8")).trim());
      fromFile = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    } catch {
      fromFile = undefined;
    }

    const fromMemory = this.syncTimes.get(gitDir);
    if (fromMemory === undefined) {
      return fromFile;
    }
    if (fromFile === undefined) {
      return fromMemory;
    }
    return Math.max(fromMemory, fromFile);
  }

  /** Path of the sync stamp inside a mirror or a clone's git directory. */
  stampPath(gitDir: string): string {
    return path.join(gitDir, SYNC_STAMP_FILE);
  }

  /** Remove the token from any text before it reaches a log or a tool result. */
  redact(value: string): string {
    return this.git.redact(value);
  }
}
