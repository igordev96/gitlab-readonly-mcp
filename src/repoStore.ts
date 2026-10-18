import { promises as fs } from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { Git, GitError, type GitRunResult } from "./git.js";

const PROJECT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const DEFAULT_FILE_MAX_BYTES = 200_000;
/** Default cap on the number of refs or entries a listing returns. */
export const DEFAULT_MAX_ENTRIES = 200;
/** Absolute cap on a listing, so one call can never dump an unbounded result. */
export const HARD_MAX_ENTRIES = 5_000;

/**
 * `for-each-ref` output format for one ref, NUL-separated so commit subjects
 * cannot be confused with field boundaries. The dereferenced fields (`*`) are
 * present only for annotated tags, which is how tags get peeled to a commit.
 */
const REF_FORMAT =
  "%(refname)%00%(objectname)%00%(*objectname)%00" +
  "%(committerdate:iso-strict)%00%(*committerdate:iso-strict)%00%(subject)";
const REF_MAX_BYTES = 4 * 1024 * 1024;
/** Byte cap for a tree listing; the entry cap usually bites first. */
const TREE_MAX_BYTES = 8 * 1024 * 1024;

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

/** Which refs a listing should include. */
export type RefKindFilter = "branches" | "tags" | "all";

/** `branch`/`tag` for a named ref; `commit` for any other revision. */
export type RefKind = "branch" | "tag" | "commit";

export interface RefEntry {
  /** Short name, e.g. `fix/PROJ-7608` or `v1.0`. */
  name: string;
  /** Full ref name, e.g. `refs/heads/fix/PROJ-7608`. */
  refname: string;
  kind: "branch" | "tag";
  /** Commit the ref points at (annotated tags are peeled to their commit). */
  commit: string;
  /** Commit date, ISO 8601. */
  date?: string;
  /** First line of the commit (or annotated tag) message. */
  subject?: string;
}

export interface ListRefsOptions {
  kind?: RefKindFilter;
  /** Case-insensitive substring of the short ref name. */
  search?: string;
  maxEntries?: number;
}

/** One entry in a tree listing: a file, or a directory. */
export interface TreeEntry {
  /** Path relative to the repository root, e.g. `src/components/Button.tsx`. */
  path: string;
  /** `blob` for a file, `tree` for a directory. */
  type: string;
  /** Octal mode, e.g. `100644` or `040000`. */
  mode: string;
  /** Git object id. */
  object: string;
  /** Size in bytes, present for blobs only. */
  size?: number;
}

export interface ListTreeOptions {
  /** Walk the whole subtree instead of just the immediate children. */
  recursive?: boolean;
  maxEntries?: number;
}

export interface TreeListResult {
  project: string;
  ref: string;
  commit: string;
  /** Directory that was listed; empty string for the repository root. */
  path: string;
  recursive: boolean;
  entries: TreeEntry[];
  /** Number of entries before the cap was applied. */
  total: number;
  truncated: boolean;
  /** When the mirror backing this listing was last synchronised, if known. */
  syncedAt?: Date;
  /** True when this listing triggered a fetch. */
  fetched: boolean;
}

export interface RefListResult {
  project: string;
  kind: RefKindFilter;
  refs: RefEntry[];
  /** Number of refs that matched before the cap was applied. */
  total: number;
  truncated: boolean;
  /** The repository's default branch, when the mirror knows one. */
  defaultBranch?: string;
  /** When the mirror backing this listing was last synchronised, if known. */
  syncedAt?: Date;
  /** True when this listing triggered a fetch. */
  fetched: boolean;
}

export interface RefLookupResult {
  project: string;
  ref: string;
  /** The commit the ref resolves to. */
  commit: string;
  kind: RefKind;
  /** Full ref name, present only when the ref really is a branch or a tag. */
  refname?: string;
  syncedAt?: Date;
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

/**
 * Levenshtein distance between two strings, using two rolling rows so memory
 * stays proportional to the shorter string rather than to the product.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length === 0) {
    return long.length;
  }

  let previous = Array.from({ length: short.length + 1 }, (_, index) => index);
  let current = new Array<number>(short.length + 1);

  for (let i = 1; i <= long.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= short.length; j += 1) {
      // Both rows are fully populated up to `short.length` on every pass.
      const deletion = previous[j]! + 1;
      const insertion = current[j - 1]! + 1;
      const substitution = previous[j - 1]! + (long.charAt(i - 1) === short.charAt(j - 1) ? 0 : 1);
      current[j] = Math.min(deletion, insertion, substitution);
    }
    [previous, current] = [current, previous];
  }

  return previous[short.length]!;
}

/**
 * Rank refs by how likely they are to be what `query` meant: names containing
 * the query (or contained in it) first, then the nearest by edit distance.
 * The distance budget scales with the query so short names do not match
 * everything.
 */
export function rankSimilar(refs: RefEntry[], query: string, limit = 5): RefEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle || limit <= 0) {
    return [];
  }
  const budget = Math.max(3, Math.ceil(needle.length / 3));

  const scored: Array<{ entry: RefEntry; distance: number; contains: boolean }> = [];
  for (const entry of refs) {
    const name = entry.name.toLowerCase();
    const contains = name.includes(needle) || needle.includes(name);
    const distance = editDistance(name, needle);
    if (contains || distance <= budget) {
      scored.push({ entry, distance, contains });
    }
  }

  scored.sort(
    (a, b) =>
      Number(b.contains) - Number(a.contains) ||
      a.distance - b.distance ||
      a.entry.name.localeCompare(b.entry.name),
  );

  return scored.slice(0, limit).map((item) => item.entry);
}

/**
 * Ref namespaces to query for a given filter.
 *
 * Deliberately limited to branches and tags. GitLab also advertises
 * `refs/merge-requests/*` (one per merge request) and a mirror clone copies
 * every ref, so "everything" would bury the two namespaces anyone actually asks
 * for.
 */
function patternsFor(kind: RefKindFilter): string[] {
  if (kind === "branches") {
    return ["refs/heads"];
  }
  if (kind === "tags") {
    return ["refs/tags"];
  }
  return ["refs/heads", "refs/tags"];
}

/**
 * Parse `git ls-tree -l -z` output.
 *
 * Each record is `<mode> SP <type> SP <object> SP <size> TAB <path>`, with the
 * size column space-padded, and records are NUL-terminated. Splitting on `-z`
 * rather than newlines means a path containing a newline cannot forge a second
 * entry; the path may itself contain a tab, so the separator is the *first* tab.
 */
export function parseTreeEntries(output: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of output.split("\u0000")) {
    if (!record) {
      continue;
    }
    const separator = record.indexOf("\t");
    if (separator === -1) {
      continue;
    }
    const [mode, type, object, rawSize] = record.slice(0, separator).trim().split(/\s+/);
    const entryPath = record.slice(separator + 1);
    if (!mode || !type || !object || !entryPath) {
      continue;
    }
    const size = rawSize && rawSize !== "-" ? Number(rawSize) : Number.NaN;
    entries.push({
      path: entryPath,
      type,
      mode,
      object,
      size: Number.isFinite(size) ? size : undefined,
    });
  }
  return entries;
}

/** A "did you mean" message for an unresolvable ref, with suggestions if any. */export function formatRefNotFound(
  project: string,
  ref: string,
  suggestions: RefEntry[] = [],
): string {
  const base = `Ref not found: "${ref}" in ${project}.`;
  if (suggestions.length === 0) {
    return base;
  }
  const lines = suggestions.map((entry) => `  ${entry.name} (${entry.kind})`);
  return `${base} Did you mean:\n${lines.join("\n")}`;
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

  /** Resolve a ref and describe what it is: a branch, a tag, or a bare revision. */
  async resolveRefInfo(project: string, ref: string): Promise<RefLookupResult | undefined> {
    const cleanProject = validateProject(project);
    const cleanRef = validateRef(ref);

    const { dir, commit, fetched } = await this.resolveWithFreshness(cleanProject, cleanRef);
    if (!commit) {
      return undefined;
    }

    const named = await this.namedRef(dir, cleanRef);
    const syncMs = await this.lastSyncAt(cleanProject, dir);
    return {
      project: cleanProject,
      ref: cleanRef,
      commit,
      kind: named?.kind ?? "commit",
      refname: named?.refname,
      syncedAt: syncMs === undefined ? undefined : new Date(syncMs),
      fetched,
    };
  }

  /**
   * List branches and/or tags.
   *
   * Freshness works like a read: the mirror is refreshed when it is past its TTL.
   * Unlike resolving a ref there is no fetch-on-miss, because a *stale* list is
   * not detectably wrong — a missing branch simply is not there. Callers should
   * therefore treat `syncedAt` as the age of the answer.
   */
  async listRefs(project: string, options: ListRefsOptions = {}): Promise<RefListResult> {
    const cleanProject = validateProject(project);
    const kind: RefKindFilter = options.kind ?? "branches";
    const dir = await this.ensureMirror(cleanProject);
    const fetched = await this.refresh(cleanProject, dir, "ttl");

    let refs = await this.rawRefs(dir, patternsFor(kind));

    const search = options.search?.trim().toLowerCase();
    if (search) {
      refs = refs.filter((entry) => entry.name.toLowerCase().includes(search));
    }

    const limit = Math.min(options.maxEntries ?? DEFAULT_MAX_ENTRIES, HARD_MAX_ENTRIES);
    const total = refs.length;
    const truncated = total > limit;
    const syncMs = await this.lastSyncAt(cleanProject, dir);

    return {
      project: cleanProject,
      kind,
      refs: truncated ? refs.slice(0, limit) : refs,
      total,
      truncated,
      defaultBranch: await this.defaultBranch(dir),
      syncedAt: syncMs === undefined ? undefined : new Date(syncMs),
      fetched,
    };
  }

  /** Ref names close to `ref`, for a "did you mean" hint on a failed lookup. */
  async suggestRefs(project: string, ref: string, limit = 5): Promise<RefEntry[]> {
    const cleanProject = validateProject(project);
    const cleanRef = validateRef(ref);
    const dir = await this.ensureMirror(cleanProject);
    await this.refresh(cleanProject, dir, "ttl");
    const refs = await this.rawRefs(dir, ["refs/heads", "refs/tags"]);
    return rankSimilar(refs, cleanRef, limit);
  }

  /**
   * List a directory at a ref: `ls-tree`, one level deep by default.
   *
   * `-l` adds blob sizes, so a caller can judge whether a file is worth reading
   * before fetching it. Paths are returned relative to the repository root, so
   * they compose directly with `get_file`.
   */
  async listTree(
    project: string,
    ref: string,
    dirPath = "",
    options: ListTreeOptions = {},
  ): Promise<TreeListResult> {
    const cleanProject = validateProject(project);
    const cleanRef = validateRef(ref);
    // `validateRepoPath` strips leading slashes; a listing also has to tolerate
    // a trailing one, or joining the prefix below would double it up.
    const cleanPath = dirPath.trim() ? validateRepoPath(dirPath).replace(/\/+$/, "") : "";
    const recursive = options.recursive ?? false;

    const { dir, commit, fetched } = await this.resolveWithFreshness(cleanProject, cleanRef);
    if (!commit) {
      throw new NotFoundError(await this.notFoundRefMessage(cleanProject, cleanRef));
    }

    // `commit:path` names the directory itself, so its *contents* are listed.
    // `commit -- path` would name the tree entry instead.
    const target = cleanPath ? `${commit}:${cleanPath}` : commit;
    const args = ["ls-tree", "-l", "-z"];
    if (recursive) {
      args.push("-r");
    }
    args.push(target);

    const listed = await this.git.run(args, { gitDir: dir, maxBytes: TREE_MAX_BYTES });
    if (listed.code !== 0) {
      throw this.treeFailure(cleanProject, cleanRef, cleanPath, listed);
    }

    // `ls-tree <commit>:<dir>` reports paths relative to `<dir>` — `index.tsx`,
    // not `src/index.tsx`. Callers need root-relative paths, so re-root them.
    const prefix = cleanPath ? `${cleanPath}/` : "";
    const all = parseTreeEntries(listed.stdout).map((entry) => ({
      ...entry,
      path: `${prefix}${entry.path}`,
    }));
    const limit = Math.min(options.maxEntries ?? DEFAULT_MAX_ENTRIES, HARD_MAX_ENTRIES);
    const syncMs = await this.lastSyncAt(cleanProject, dir);

    return {
      project: cleanProject,
      ref: cleanRef,
      commit,
      path: cleanPath,
      recursive,
      entries: all.slice(0, limit),
      total: all.length,
      // A byte-capped listing can also be short, so treat both as truncation.
      truncated: all.length > limit || listed.truncated,
      syncedAt: syncMs === undefined ? undefined : new Date(syncMs),
      fetched,
    };
  }

  /**
   * Turn an `ls-tree` failure into a clean error. Listing a *file* is a common
   * mistake worth naming, because git's "not a tree object" never says which
   * tool the caller actually wanted.
   */
  private treeFailure(
    project: string,
    ref: string,
    dirPath: string,
    result: GitRunResult,
  ): Error {
    if (/not a tree object/i.test(result.stderr)) {
      return new NotFoundError(
        `"${dirPath}" is a file at "${ref}" in ${project}, not a directory. Use get_file to read it.`,
      );
    }
    if (/not a valid object name|does not exist|invalid object name/i.test(result.stderr)) {
      return new NotFoundError(`Path not found: "${dirPath}" at "${ref}" in ${project}.`);
    }
    return new GitError(
      `Failed to list "${dirPath || "/"}" at "${ref}" in ${project}.`,
      result.code,
      this.redact(result.stderr).trim(),
    );
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
      throw new NotFoundError(await this.notFoundRefMessage(cleanProject, cleanRef));
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
   * Read every ref under `patterns`.
   *
   * Fields are NUL-separated rather than whitespace-separated so a commit
   * subject can contain anything without corrupting the row.
   */
  private async rawRefs(dir: string, patterns: string[]): Promise<RefEntry[]> {
    const result = await this.git.run(
      ["for-each-ref", `--format=${REF_FORMAT}`, ...patterns],
      { gitDir: dir, maxBytes: REF_MAX_BYTES },
    );
    if (result.code !== 0) {
      throw new GitError(
        "Failed to list refs.",
        result.code,
        this.redact(result.stderr).trim(),
      );
    }

    const refs: RefEntry[] = [];
    for (const line of result.stdout.split("\n")) {
      const [refname, object, peeled, date, peeledDate, subject] = line.split("\u0000");
      if (!refname || !object) {
        continue;
      }

      const prefix = refname.startsWith("refs/heads/")
        ? "refs/heads/"
        : refname.startsWith("refs/tags/")
          ? "refs/tags/"
          : undefined;
      if (!prefix) {
        continue;
      }

      refs.push({
        name: refname.slice(prefix.length),
        refname,
        kind: prefix === "refs/heads/" ? "branch" : "tag",
        // An annotated tag's own object id is the tag object; the peeled id is
        // the commit it ultimately points at.
        commit: peeled || object,
        date: peeledDate || date || undefined,
        subject: subject || undefined,
      });
    }
    return refs;
  }

  /** The repository's default branch, as recorded in the mirror's HEAD. */
  private async defaultBranch(dir: string): Promise<string | undefined> {
    const result = await this.git.run(["symbolic-ref", "--short", "HEAD"], {
      gitDir: dir,
      maxBytes: 4096,
    });
    if (result.code !== 0) {
      return undefined;
    }
    return result.stdout.trim() || undefined;
  }

  /**
   * Classify a ref that already resolved. A raw (possibly abbreviated) object
   * id is never a named ref; branches are checked before tags, matching git's
   * own precedence when a branch and a tag share a name.
   */
  private async namedRef(
    dir: string,
    ref: string,
  ): Promise<{ refname: string; kind: "branch" | "tag" } | undefined> {
    if (/^[0-9a-f]{7,40}$/i.test(ref)) {
      return undefined;
    }
    for (const [prefix, kind] of [
      ["refs/heads/", "branch"],
      ["refs/tags/", "tag"],
    ] as const) {
      const refname = `${prefix}${ref}`;
      const result = await this.git.run(["show-ref", "--verify", "--quiet", refname], {
        gitDir: dir,
        maxBytes: 1024,
      });
      if (result.code === 0) {
        return { refname, kind };
      }
    }
    return undefined;
  }

  /**
   * Build the "not found" message for a ref, adding close matches when we can
   * work them out. Suggestions are a nicety: if listing refs fails for any
   * reason the plain message is still the right answer.
   */
  private async notFoundRefMessage(project: string, ref: string): Promise<string> {
    const suggestions = await this.suggestRefs(project, ref).catch(() => [] as RefEntry[]);
    return formatRefNotFound(project, ref, suggestions);
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
