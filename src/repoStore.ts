import path from "node:path";
import type { Config, FetchMode } from "./config.js";
import { Git, GitError, type GitRunResult } from "./git.js";
import { explainGitError } from "./gitDiagnostics.js";
import { RepoRegistry, type RepoEntry, type RepoSource } from "./registry.js";
import { SourceManager, type GitSource } from "./sources.js";
import { parseGitlabUrl, resolveUrlParts, type LineRange } from "./url.js";

const PROJECT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const DEFAULT_FILE_MAX_BYTES = 200_000;
/** Absolute cap on a file read, applied when a line range needs the whole file. */
export const HARD_FILE_MAX_BYTES = 20_000_000;
/** Default cap on the number of refs or entries a listing returns. */
export const DEFAULT_MAX_ENTRIES = 200;
/** Absolute cap on a listing, so one call can never dump an unbounded result. */
export const HARD_MAX_ENTRIES = 5_000;
/** Default number of matches a search returns. */
export const DEFAULT_MAX_MATCHES = 100;
/** Absolute cap on a search, so one call can never dump an unbounded result. */
export const HARD_MAX_MATCHES = 2_000;
/** Lines of context a search may ask for on each side of a match. */
export const HARD_CONTEXT_RADIUS = 50;
/**
 * How many displayed files a context search reads. Each one costs a `git show`,
 * so the budget is per call rather than per match.
 */
export const CONTEXT_MAX_FILES = 20;
/** Default number of commits `pickaxe` returns. */
export const DEFAULT_PICKAXE_LIMIT = 20;
/** Byte cap for search output; the match cap usually bites first. */
const SEARCH_MAX_BYTES = 5 * 1024 * 1024;
/** Cap on the search text itself, so a pathological pattern cannot get through. */
const MAX_QUERY_CHARS = 500;

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
/** One `git log` row for `pickaxe`: short sha, date, author, subject. */
const PICKAXE_FORMAT = "%h%x09%ad%x09%an%x09%s";

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
  /** Present when a line range was asked for: what was sliced out of the file. */
  lines?: ReadLineRange;
  /** When the source backing this read was last synchronised, if known. */
  syncedAt?: Date;
  /** True when this read triggered a fetch. */
  fetched: boolean;
  /** Set when the freshness check failed and this answer came from the cache. */
  refreshError?: string;
}

/** What a requested line range actually yielded. */
export interface ReadLineRange {
  /** The range that was asked for, 1-based and inclusive. */
  from: number;
  to: number;
  /** First line present in the file within the range, or `undefined` when none is. */
  availableFrom?: number;
  /** Last line present in the file within the range, or `undefined` when none is. */
  availableTo?: number;
  /** Lines in the file, as far as this read went (exact unless `truncated`). */
  fileLines: number;
}

/** Options for a single file read. */
export interface FileReadOptions {
  /** Return only this 1-based, inclusive line range. */
  lines?: LineRange;
}

/** A GitLab web URL, parsed and — unless asked not to — resolved. */
export interface ResolvedUrl {
  /** The link as given. */
  url: string;
  host: string;
  project: string;
  target: "file" | "directory";
  /** The ref, split out of the URL using the project's own refs. */
  ref: string;
  /** File or directory path; empty for a `/-/tree/<ref>` root link. */
  path: string;
  /** True when `ref` is a ref this project has, rather than the first segment. */
  refConfirmed: boolean;
  refKind?: "branch" | "tag";
  /** A `#L12-20` anchor, when the link carried one. */
  lines?: LineRange;
  /** Set when the ref resolved to a commit. */
  commit?: string;
  /** Where the project is read from, when it was resolved. */
  source?: RepoSource;
  syncedAt?: Date;
  /** True when resolving triggered a fetch. */
  fetched?: boolean;
  /** Set when the freshness check failed and the refs came from the cache. */
  refreshError?: string;
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
  /** When the source backing this listing was last synchronised, if known. */
  syncedAt?: Date;
  /** True when this listing triggered a fetch. */
  fetched: boolean;
  /** Set when the freshness check failed and this answer came from the cache. */
  refreshError?: string;
}

export interface RefListResult {
  project: string;
  kind: RefKindFilter;
  refs: RefEntry[];
  /** Number of refs that matched before the cap was applied. */
  total: number;
  truncated: boolean;
  /** The repository's default branch, when the source knows one. */
  defaultBranch?: string;
  /** When the source backing this listing was last synchronised, if known. */
  syncedAt?: Date;
  /** True when this listing triggered a fetch. */
  fetched: boolean;
  /** Set when the freshness check failed and this answer came from the cache. */
  refreshError?: string;
}

/** How a search should be run. */
export interface SearchOptions {
  /** The ref to search. Omitted means the source's HEAD — its default branch. */
  ref?: string;
  /** A git pathspec, so globs work. Absent searches the whole tree. */
  path?: string;
  /** Default false: search ignores case unless this is set. */
  caseSensitive?: boolean;
  /** Treat the query as POSIX extended regex (`-E`) rather than a literal (`-F`). */
  regex?: boolean;
  maxMatches?: number;
  /**
   * Lines of context around each displayed match. Default 0, none.
   *
   * git can emit context itself (`-C`), but under `-z` it writes the context in
   * the match layout, so nothing distinguishes a matched line from a nearby one.
   * Reading the file once per displayed file is what keeps that distinction — and
   * it is why `context` needs `output: "matches"`, and stops at
   * `CONTEXT_MAX_FILES`.
   */
  context?: number;
  /**
   * What to return: every match, or just which files (or how many each holds).
   * Default `matches`. The cheap two never parse a matched line, so their totals
   * stay exact where a match list would have been capped.
   */
  output?: SearchOutput;
}

/** Which shape a search returns. */
export type SearchOutput = "matches" | "files" | "count";

/** One file that matched, for the `files` and `count` outputs. */
export interface FileHit {
  path: string;
  /** Matching lines in that file; absent in `files` mode, which does not count. */
  count?: number;
}

/** One matching line, with the file it is in. */
export interface SearchMatch {
  path: string;
  /** 1-based line number. */
  line: number;
  /** The matched line, verbatim. Long lines are cut by the renderer, not here. */
  text: string;
}

/** One line of a context hunk: its number, its text, and whether it matched. */
export interface ContextLine {
  line: number;
  text: string;
  matched: boolean;
}

/** The lines shown around the matches in one file. */
export interface FileContext {
  path: string;
  /** Merged, ascending ranges around the displayed matches; empty when `note` says why. */
  lines: ContextLine[];
  /** Why `lines` is empty, when it is: the file was not read, or not among the first few. */
  note?: string;
}

/** Match context for a whole result. */
export interface MatchContext {
  /** Lines of context on each side of a match, as asked for. */
  radius: number;
  /** One entry per displayed file, in the order the matches came back. */
  files: FileContext[];
}

export interface SearchResult {
  project: string;
  /** The ref that was searched: the one asked for, or the source's HEAD. */
  ref: string;
  /** The commit the ref resolved to; the search ran against this, not the name. */
  commit: string;
  query: string;
  /** Whether the query was a regular expression. */
  regex: boolean;
  caseSensitive: boolean;
  path?: string;
  /** Which shape was asked for. */
  output: SearchOutput;
  /** `output: "matches"`: the matches, cut to `maxMatches`. Empty in the other modes. */
  matches: SearchMatch[];
  /** `output: "files"|"count"`: the files that matched, cut to `maxMatches`. */
  fileHits: FileHit[];
  /** Match context, present only when it was asked for. */
  context?: MatchContext;
  /**
   * Matches found, which is the true number unless the output was cut. Absent in
   * `files` mode, which never asks git to count them.
   */
  total?: number;
  /**
   * Distinct files among *all* the matches found, not just the ones returned.
   * Counting only the returned slice would report `682 matches in 3 files`, which
   * reads as a fact about the repository and is not one.
   */
  files: number;
  /** True when `maxMatches` hid rows, or the byte cap cut the output. */
  truncated: boolean;
  /** True only for the byte cap: `total` and `files` are then lower bounds. */
  outputTruncated: boolean;
  syncedAt?: Date;
  fetched: boolean;
  /** Set when the freshness check failed and this answer came from the cache. */
  refreshError?: string;
}

/** How a pickaxe should be run. */
export interface PickaxeOptions {
  /** The ref whose history to walk. Omitted means the source's HEAD. */
  ref?: string;
  /** A git pathspec, so globs work. Absent considers the whole tree. */
  path?: string;
  /** Default false: follow the text whatever its case, as `search` does. */
  caseSensitive?: boolean;
  limit?: number;
}

/** One commit that changed how often the text appears. */
export interface PickaxeEntry {
  commit: string;
  /** Commit date, `YYYY-MM-DD`. */
  date?: string;
  author?: string;
  subject?: string;
}

export interface PickaxeResult {
  project: string;
  ref: string;
  commit: string;
  query: string;
  caseSensitive: boolean;
  path?: string;
  entries: PickaxeEntry[];
  truncated: boolean;
  syncedAt?: Date;
  fetched: boolean;
  /** Set when the freshness check failed and this answer came from the cache. */
  refreshError?: string;
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
  /** Set when the freshness check failed and this answer came from the cache. */
  refreshError?: string;
}

/** One registered project, as `list_repos` reports it. */
export interface RepoSummary {
  project: string;
  source: RepoSource;
  /** The effective policy: this project's override, else the configured default. */
  freshnessMode: FetchMode;
  freshnessTtlSeconds: number;
  /** Whether the stored data is on disk: the mirror, or the registered clone. */
  present: boolean;
  /** Set for a local-clone registration. */
  localPath?: string;
  /**
   * Last *successful* sync, from the source's own stamp. Absent when it has never
   * synced, or when the registered data is not there to be measured.
   */
  syncedAt?: Date;
}

export interface RepoListing {
  repos: RepoSummary[];
}

/** What `sync_repo` did. */
export interface RepoSyncResult {
  project: string;
  /** The git directory that was fetched: the mirror, or the clone's. */
  gitDir: string;
  syncedAt?: Date;
}

/** What `add_repo` registered. */
export interface AddRepoResult {
  project: string;
  source: RepoSource;
  /** The path recorded for a local-clone registration. */
  localPath?: string;
  /** True when the project had already been registered and was updated. */
  updated: boolean;
}

/** What `remove_repo` forgot, and what it deleted. */
export interface RemoveRepoResult {
  project: string;
  /** False when nothing had been registered under that project. */
  registered: boolean;
  /** The mirror that was deleted, when `deleteMirror` was asked for and it had one. */
  deletedMirror?: string;
  /** True when the delete was refused because the registration is a local clone. */
  keptLocalClone: boolean;
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
 * Guard the search text. It is passed to git as a single argument, so only NUL
 * and newlines are outright illegal; the length cap exists so a single call
 * cannot hand git a pattern that takes minutes to fail on.
 */
export function validateQuery(query: string): string {
  if (!query.trim()) {
    throw new Error("query must not be empty.");
  }
  if (query.length > MAX_QUERY_CHARS) {
    throw new Error(`query must be at most ${MAX_QUERY_CHARS} characters.`);
  }
  if (/[\u0000\n\r]/.test(query)) {
    throw new Error("query contains illegal characters.");
  }
  return query;
}

/**
 * Cut a 1-based, inclusive line range out of a file's text.
 *
 * Git hands back the blob verbatim, so a range is a slice of that text — but the
 * *line numbers* are the point: the caller asked because a link pointed at them.
 * A range running past the end is clamped rather than refused, and the caller is
 * told how many lines the file actually has. CRLF endings survive, because the
 * text is split on `\n` and rejoined the same way, leaving each `\r` with its line.
 */
export function sliceLines(
  text: string,
  range: LineRange,
): { text: string; availableFrom?: number; availableTo?: number; fileLines: number } {
  const lines = text.split("\n");
  // A trailing newline ends the last line; it does not start an empty one.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const fileLines = lines.length;
  const from = Math.max(1, range.from);
  const to = Math.min(range.to, fileLines);
  if (from > to) {
    return { text: "", fileLines };
  }
  return {
    text: lines.slice(from - 1, to).join("\n"),
    availableFrom: from,
    availableTo: to,
    fileLines,
  };
}

/**
 * Split `git grep -z` output into records of `width` fields.
 *
 * `-z` separates the fields with NUL but still ends each *record* with a newline,
 * so a record's last field holds its own value *and* the first field of the next
 * record, joined by that newline:
 *
 *   matches: `rev:path \0 line \0 text \n rev:path \0 line \0 text \n`
 *   --count: `rev:path \0 count \n rev:path \0 count \n`
 *
 * Only that final field is cut, and only at its first newline: a path always sits
 * in a field of its own, and a path may contain a newline — the very case `-z`
 * exists for. A record the byte cap tore in half never completes and is dropped
 * rather than guessed at.
 */
function zRecords(output: string, width: number): string[][] {
  const tokens = output.split("\u0000");
  const records: string[][] = [];
  let record: string[] = [];

  for (const token of tokens) {
    if (record.length !== width - 1) {
      record.push(token);
      continue;
    }

    const join = token.indexOf("\n");
    record.push(join === -1 ? token : token.slice(0, join));
    records.push(record);
    record = join === -1 ? [] : [token.slice(join + 1)];
  }

  return records;
}

/**
 * Parse `git grep --line-number -z` output.
 *
 * The `rev:` prefix is stripped by exact match on the revision we passed, so a
 * path containing a colon survives.
 */
export function parseGrepMatches(output: string, rev: string): SearchMatch[] {
  const prefix = `${rev}:`;
  const matches: SearchMatch[] = [];

  for (const [head, lineField, text] of zRecords(output, 3)) {
    const line = Number.parseInt(lineField ?? "", 10);
    if (head?.startsWith(prefix) && Number.isInteger(line)) {
      matches.push({
        path: head.slice(prefix.length),
        line,
        text: (text ?? "").replace(/\r$/, ""),
      });
    }
  }

  return matches;
}

/**
 * Parse `git grep -l -z` output: `rev:path \0` per file.
 *
 * This one is not a `zRecords` shape at all: with `-l` git writes no newline after
 * a record, so every field is complete path and the only separator is the NUL. A
 * complete listing ends with one, so a non-empty final element is a path the byte
 * cap cut in half — it is dropped rather than reported as a file that does not
 * exist. A path containing a newline is safe for exactly the reason a truncated
 * one is dangerous: the NUL is the separator, and nothing else is.
 */
export function parseGrepPaths(output: string, rev: string): string[] {
  const prefix = `${rev}:`;
  const tokens = output.split("\u0000");
  // The final element is either the empty tail after the last NUL, or a torn path.
  // Either way it is not a path and goes.
  tokens.pop();
  return tokens
    .filter((token) => token.startsWith(prefix))
    .map((token) => token.slice(prefix.length));
}

/**
 * Parse `git grep --count -z` output: `rev:path \0 count \n` per file that matched.
 *
 * The count is the number of matching *lines*, which is what a match list would
 * have shown one row per, so the two modes agree. A zero is dropped: `git grep -c`
 * prints one for a file a pathspec named but that did not match, and that is not a
 * file with a match in it.
 */
export function parseGrepCounts(output: string, rev: string): FileHit[] {
  const prefix = `${rev}:`;
  const hits: FileHit[] = [];

  for (const [head, countField] of zRecords(output, 2)) {
    const count = Number.parseInt(countField ?? "", 10);
    if (head?.startsWith(prefix) && Number.isInteger(count) && count > 0) {
      hits.push({ path: head.slice(prefix.length), count });
    }
  }

  return hits;
}

/**
 * Merge the windows around each matched line into ascending, non-overlapping
 * ranges, clamped to the file.
 *
 * Two windows that touch or overlap become one, so a run of nearby matches is
 * shown once rather than once per match — which is what stops a file with a match
 * on every line from repeating the same lines a hundred times.
 */
export function contextRanges(
  matchLines: number[],
  radius: number,
  fileLines: number,
): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  const ascending = [...new Set(matchLines)].sort((left, right) => left - right);

  for (const line of ascending) {
    const from = Math.max(1, line - radius);
    const to = Math.min(fileLines, line + radius);
    if (to < from) {
      continue;
    }
    const last = ranges[ranges.length - 1];
    if (last && from <= last.to + 1) {
      last.to = Math.max(last.to, to);
    } else {
      ranges.push({ from, to });
    }
  }

  return ranges;
}

/**
 * Turn a file's text into the lines its ranges cover, in order, marking the
 * matched ones. A trailing `\r` is dropped, so a CRLF file reads like the match
 * rows do — the renderer flattens both through the same function.
 */
export function contextLines(
  fileText: string,
  matchLines: number[],
  radius: number,
): ContextLine[] {
  const all = fileText.split("\n");
  // A file ending in a newline splits into a phantom last element.
  if (all[all.length - 1] === "") {
    all.pop();
  }

  const matched = new Set(matchLines);
  const lines: ContextLine[] = [];
  for (const range of contextRanges(matchLines, radius, all.length)) {
    for (let number = range.from; number <= range.to; number += 1) {
      lines.push({
        line: number,
        text: (all[number - 1] ?? "").replace(/\r$/, ""),
        matched: matched.has(number),
      });
    }
  }
  return lines;
}

/**
 * Parse `git log --format=<short sha>%x09<date>%x09<author>%x09<subject>`.
 * A subject may itself contain tabs, so everything after the third field is the
 * subject again rather than a fourth field.
 */
export function parsePickaxeEntries(output: string): PickaxeEntry[] {
  const entries: PickaxeEntry[] = [];
  for (const line of output.split("\n")) {
    if (!line) {
      continue;
    }
    const fields = line.split("\t");
    const commit = fields[0] ?? "";
    if (!commit) {
      continue;
    }
    entries.push({
      commit,
      date: fields[1] || undefined,
      author: fields[2] || undefined,
      subject: fields.length > 3 ? fields.slice(3).join("\t") : undefined,
    });
  }
  return entries;
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
 *
 * A local clone needs a third namespace: after `git clone`, every branch but the
 * checked-out one lives under `refs/remotes/<remote>/`, so a listing built from
 * `refs/heads` alone would hide most of the branches the clone has.
 */
function patternsFor(kind: RefKindFilter, source: GitSource): string[] {
  const remotes =
    source.kind === "local" && source.remote ? [`refs/remotes/${source.remote}`] : [];
  if (kind === "branches") {
    return ["refs/heads", ...remotes];
  }
  if (kind === "tags") {
    return ["refs/tags"];
  }
  return ["refs/heads", ...remotes, "refs/tags"];
}

/**
 * Strip a ref name down to what a caller asked for, or say it is not one of the
 * namespaces we list (`refs/merge-requests/…`, a clone's `refs/remotes/<r>/HEAD`).
 */
function classifyRef(
  refname: string,
  remote: string | undefined,
): { name: string; kind: "branch" | "tag" } | undefined {
  if (refname.startsWith("refs/heads/")) {
    return { name: refname.slice("refs/heads/".length), kind: "branch" };
  }
  if (refname.startsWith("refs/tags/")) {
    return { name: refname.slice("refs/tags/".length), kind: "tag" };
  }
  const prefix = remote ? `refs/remotes/${remote}/` : undefined;
  if (prefix && refname.startsWith(prefix)) {
    const name = refname.slice(prefix.length);
    // `refs/remotes/origin/HEAD` is a symbolic ref to the default branch, not a
    // branch of its own.
    return name === "HEAD" || name.startsWith("HEAD/") ? undefined : { name, kind: "branch" };
  }
  return undefined;
}

/**
 * The names a ref can be addressed by in a source, in the order to try them.
 *
 * A mirror knows every branch and tag directly. A clone is different in a way
 * that matters: only the checked-out branch exists as a local branch — every
 * other branch is in `refs/remotes/<remote>/`, where a bare name will not find
 * it. The local name is tried first, so a clone answers with its own branch
 * (including commits that were never pushed) and only falls back to the remote's.
 */
function refCandidates(source: GitSource, ref: string): string[] {
  if (source.kind !== "local" || !source.remote || ref.startsWith("refs/")) {
    return [ref];
  }
  return [ref, `refs/remotes/${source.remote}/${ref}`];
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

/**
 * The text of a thrown value, for reporting without a stack.
 *
 * A git failure is composed exactly as a hard failure would be, so a degraded
 * read carries the same diagnosis — which is the part that says whether this was
 * a token, a VPN, or a private CA — and not just the fact that it failed.
 */
function describeError(error: unknown): string {
  if (error instanceof GitError) {
    return explainGitError(error);
  }
  return error instanceof Error ? error.message : String(error);
}

type RefreshReason = "ttl" | "miss";

/** What a freshness check did: whether a fetch ran, and why a failed one failed. */
interface RefreshOutcome {
  fetched: boolean;
  /** Set when a fetch was attempted and failed. The source is still readable. */
  error?: string;
  /** Set when policy forbade fetching, so nothing was attempted at all. */
  skipped?: "manual";
}

interface ResolvedRef {
  /** The source that answered: a mirror, or a registered clone. */
  source: GitSource;
  ref: string;
  project: string;
  commit?: string;
  fetched: boolean;
  /** Set when the freshness check tried to fetch and could not. */
  refreshError?: string;
  /** Set when the freshness check did not try, because the project is `manual`. */
  skipped?: "manual";
}

/**
 * Resolves GitLab projects to a local git view and reads from them.
 *
 * A project is registered the first time it is used, and its registry entry
 * decides where it is read from: a bare mirror the server maintains, or a clone
 * of the operator's own (`add_repo`) — which is read, never cloned, and fetched
 * only when a ref is missing from it. The freshness policy can be overridden per
 * project, including `manual`, which never fetches by itself; `sync_repo`
 * refreshes whatever the project is backed by, on demand.
 *
 * Freshness: a project is refreshed according to its policy (its registry entry,
 * else `fetchMode`/`fetchTtlSeconds`), and a ref that is not found locally
 * triggers one extra fetch before giving up. The last sync time is exposed so
 * callers can see how fresh an answer is.
 */
export class RepoStore {
  private readonly registry: RepoRegistry;
  private readonly sources: SourceManager;

  constructor(
    private readonly config: Config,
    private readonly git: Git,
  ) {
    this.registry = new RepoRegistry(config.cacheDir);
    this.sources = new SourceManager(config, git);
  }

  /** Filesystem path of the bare mirror for a project. */
  mirrorPath(project: string): string {
    return this.sources.mirrorPath(validateProject(project));
  }

  /**
   * Fetch a project now, whatever its freshness policy says. This is the explicit
   * control that makes `manual` usable, and the only fetch that bypasses the TTL.
   *
   * It follows the project's source: a mirror is cloned if it is missing, a
   * registered clone is fetched from its own remote. Because a mirror was created
   * with `--mirror`, its fetch updates all refs, prunes deleted ones, and honours
   * force-pushes.
   *
   * A failure here is the answer rather than a footnote: the caller asked for
   * this fetch specifically, so it throws instead of answering from the cache.
   */
  async syncRepo(project: string): Promise<RepoSyncResult> {
    const clean = validateProject(project);
    // The one place that may clone a `manual` project: this call is the operator
    // asking for it.
    const source = await this.resolveSource(clean, { allowClone: true });
    await this.sources.enqueue(source.gitDir, () => this.sources.fetch(clean, source));
    const syncMs = await this.sources.lastSyncAt(source.gitDir);
    return {
      project: clean,
      gitDir: source.gitDir,
      syncedAt: syncMs === undefined ? undefined : new Date(syncMs),
    };
  }

  /**
   * Register a project, without touching the network.
   *
   * With a `localPath` the project is registered as a clone and the path is
   * validated here: learning at read time that a path is wrong would be a worse
   * way to find out. Without one it is registered as mirror-backed, which also
   * makes it appear in `list_repos` before it is first read.
   *
   * Registering is not fetching — nothing is cloned or fetched here — and a
   * policy field already recorded for the project (a hand-written `freshnessMode`,
   * say) is kept.
   */
  async addRepo(project: string, localPath?: string): Promise<AddRepoResult> {
    const clean = validateProject(project);
    const updated = (await this.registry.get(clean)) !== undefined;

    if (localPath === undefined) {
      await this.registry.set(clean, {
        source: "mirror",
        cloneStrategy: "full",
        localPath: undefined,
      });
      return { project: clean, source: "mirror", updated };
    }

    // Resolving the path first means a bad one is refused by the tool that
    // records it, rather than by the read that trusts it.
    await this.sources.localSource(clean, localPath);
    const stored = path.resolve(localPath);
    await this.registry.set(clean, { source: "local", localPath: stored, cloneStrategy: "full" });
    return { project: clean, source: "local", localPath: stored, updated };
  }

  /**
   * Forget a project, and optionally delete the mirror it was using.
   *
   * A registered local clone is never deleted: it is the operator's repository,
   * and this tool does not own it. For the same reason the delete itself is
   * refused for anything outside the cache's `mirrors` tree.
   *
   * Forgetting a mirror-backed project does not stick in the way it might seem to:
   * the next read registers it again and clones it again if the mirror was
   * deleted. Removing a *local* registration is the way to fall back to a mirror,
   * and that does stick.
   */
  async removeRepo(
    project: string,
    options: { deleteMirror?: boolean } = {},
  ): Promise<RemoveRepoResult> {
    const clean = validateProject(project);
    const entry = await this.registry.get(clean);
    const registered = await this.registry.remove(clean);

    const destructive = options.deleteMirror === true;
    const keptLocalClone = destructive && entry?.source === "local";
    let deletedMirror: string | undefined;
    if (destructive && !keptLocalClone) {
      const dir = this.mirrorPath(clean);
      if (await this.sources.exists(dir)) {
        await this.sources.removeMirror(clean, dir);
        deletedMirror = dir;
      }
    }

    return { project: clean, registered, deletedMirror, keptLocalClone };
  }

  /**
   * Every registered project, with its effective policy and how fresh it is.
   *
   * The sync time comes from the source's own stamp rather than from a field in
   * the registry, so there is one clock: a project that has never synced reports
   * no time at all, instead of the moment it was registered.
   */
  async listRepos(): Promise<RepoListing> {
    const repos: RepoSummary[] = [];
    for (const { project, entry } of await this.registry.all()) {
      const policy = this.effectivePolicy(entry);
      let present = false;
      let syncedAt: Date | undefined;
      try {
        const source = await this.sourceFor(project, entry);
        present = await this.sourcePresent(source);
        if (present) {
          const syncMs = await this.sources.lastSyncAt(source.gitDir);
          syncedAt = syncMs === undefined ? undefined : new Date(syncMs);
        }
      } catch {
        // A registration whose path is unusable is still worth listing: `present`
        // is exactly the field that should say so. A read reports the reason.
        present = false;
      }
      repos.push({
        project,
        source: entry.source,
        freshnessMode: policy.mode,
        freshnessTtlSeconds: policy.ttlSeconds,
        present,
        localPath: entry.localPath,
        syncedAt,
      });
    }
    return { repos };
  }

  /** Resolve a ref to a commit SHA, or undefined when it does not exist. */
  async resolveRef(project: string, ref: string): Promise<string | undefined> {
    const { commit } = await this.resolveWithFreshness(project, ref);
    return commit;
  }

  /**
   * Resolve a ref and describe what it is: a branch, a tag, or a bare revision.
   *
   * Throws `NotFoundError` when the ref does not resolve: the message lists close
   * matches, and admits it when the source could not be refreshed — a missing ref
   * is not proof of absence when the view behind it is out of date.
   */
  async resolveRefInfo(project: string, ref: string): Promise<RefLookupResult> {
    const cleanProject = validateProject(project);
    const cleanRef = validateRef(ref);

    const { source, commit, fetched, refreshError, skipped } = await this.resolveWithFreshness(
      cleanProject,
      cleanRef,
    );
    if (!commit) {
      throw new NotFoundError(
        await this.notFoundRefMessage(cleanProject, cleanRef, {
          refreshError,
          skipped,
          sourceKind: source.kind,
        }),
      );
    }

    const named = await this.namedRef(source, cleanRef);
    const syncMs = await this.sources.lastSyncAt(source.gitDir);
    return {
      project: cleanProject,
      ref: cleanRef,
      commit,
      kind: named?.kind ?? "commit",
      refname: named?.refname,
      syncedAt: syncMs === undefined ? undefined : new Date(syncMs),
      fetched,
      refreshError,
    };
  }

  /**
   * List branches and/or tags.
   *
   * Freshness works like a read: a mirror is refreshed when it is past its TTL. A
   * registered clone is not: it belongs to the operator, and only a miss or an
   * explicit `sync_repo` writes to it. Unlike resolving a ref there is no
   * fetch-on-miss while listing, because a *stale* list is not detectably wrong —
   * a missing branch simply is not there. Callers should therefore treat
   * `syncedAt` as the age of the answer.
   */
  async listRefs(project: string, options: ListRefsOptions = {}): Promise<RefListResult> {
    const cleanProject = validateProject(project);
    const kind: RefKindFilter = options.kind ?? "branches";
    const source = await this.resolveSource(cleanProject);
    const outcome = await this.refresh(cleanProject, source, "ttl");

    let refs = await this.rawRefs(source, patternsFor(kind, source));

    const search = options.search?.trim().toLowerCase();
    if (search) {
      refs = refs.filter((entry) => entry.name.toLowerCase().includes(search));
    }

    const limit = Math.min(options.maxEntries ?? DEFAULT_MAX_ENTRIES, HARD_MAX_ENTRIES);
    const total = refs.length;
    const truncated = total > limit;
    const syncMs = await this.sources.lastSyncAt(source.gitDir);

    return {
      project: cleanProject,
      kind,
      refs: truncated ? refs.slice(0, limit) : refs,
      total,
      truncated,
      defaultBranch: await this.defaultBranch(source.gitDir),
      syncedAt: syncMs === undefined ? undefined : new Date(syncMs),
      fetched: outcome.fetched,
      refreshError: outcome.error,
    };
  }

  /** Ref names close to `ref`, for a "did you mean" hint on a failed lookup. */
  async suggestRefs(project: string, ref: string, limit = 5): Promise<RefEntry[]> {
    const cleanProject = validateProject(project);
    const cleanRef = validateRef(ref);
    const source = await this.resolveSource(cleanProject);
    await this.refresh(cleanProject, source, "ttl");
    const refs = await this.rawRefs(source, patternsFor("all", source));
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

    const { source, commit, fetched, refreshError, skipped } = await this.resolveWithFreshness(
      cleanProject,
      cleanRef,
    );
    if (!commit) {
      throw new NotFoundError(
        await this.notFoundRefMessage(cleanProject, cleanRef, {
          refreshError,
          skipped,
          sourceKind: source.kind,
        }),
      );
    }

    // `commit:path` names the directory itself, so its *contents* are listed.
    // `commit -- path` would name the tree entry instead.
    const target = cleanPath ? `${commit}:${cleanPath}` : commit;
    const args = ["ls-tree", "-l", "-z"];
    if (recursive) {
      args.push("-r");
    }
    args.push(target);

    const listed = await this.git.run(args, { gitDir: source.gitDir, maxBytes: TREE_MAX_BYTES });
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
    const syncMs = await this.sources.lastSyncAt(source.gitDir);

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
      refreshError,
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
    options: FileReadOptions = {},
  ): Promise<FileReadResult> {
    const cleanProject = validateProject(project);
    const cleanRef = validateRef(ref);
    const cleanPath = validateRepoPath(filePath);

    const { source, commit, fetched, refreshError, skipped } = await this.resolveWithFreshness(
      cleanProject,
      cleanRef,
    );
    if (!commit) {
      throw new NotFoundError(
        await this.notFoundRefMessage(cleanProject, cleanRef, {
          refreshError,
          skipped,
          sourceKind: source.kind,
        }),
      );
    }

    // A line range has to be cut out of the *whole* file, and the caller's byte cap
    // would often cut the range away before it arrived — a 200 KB cap cannot show
    // line 9000 of a 4 MB file. So a ranged read goes to the hard cap instead, and
    // reports it when even that was not enough for the range to be complete.
    const limit = options.lines ? HARD_FILE_MAX_BYTES : maxBytes;
    // Resolve by SHA so the path can never be mistaken for a ref, and so the
    // returned provenance is unambiguous.
    const shown = await this.git.run(["show", `${commit}:${cleanPath}`], {
      gitDir: source.gitDir,
      maxBytes: limit,
    });
    if (shown.code !== 0) {
      throw new NotFoundError(
        `Path not found: "${cleanPath}" at "${cleanRef}" in ${cleanProject}.`,
      );
    }

    const binary = shown.stdout.includes("\u0000");
    const sliced =
      options.lines && !binary ? sliceLines(shown.stdout, options.lines) : undefined;
    const syncMs = await this.sources.lastSyncAt(source.gitDir);
    return {
      project: cleanProject,
      ref: cleanRef,
      commit,
      path: cleanPath,
      content: sliced ? sliced.text : shown.stdout,
      truncated: shown.truncated,
      binary,
      lines: options.lines
        ? {
            from: options.lines.from,
            to: options.lines.to,
            availableFrom: sliced?.availableFrom,
            availableTo: sliced?.availableTo,
            fileLines: sliced?.fileLines ?? 0,
          }
        : undefined,
      syncedAt: syncMs === undefined ? undefined : new Date(syncMs),
      fetched,
      refreshError,
    };
  }

  /**
   * Parse a GitLab web URL, and — unless told not to — resolve the ref inside it.
   *
   * Resolving is the default because the caller has the link *and* wants what it
   * points at; `resolve: false` is the offline inspection mode, which touches
   * neither the registry nor the network. A ref that cannot be resolved is not an
   * error here: the result says `refConfirmed: false` or leaves `commit` unset, and
   * the reader that follows fails with the usual close-match suggestions, which
   * help more than a parse-level complaint would.
   */
  async resolveUrl(url: string, options: { resolve?: boolean } = {}): Promise<ResolvedUrl> {
    const parsed = parseGitlabUrl(url, this.config.host);
    const cleanProject = validateProject(parsed.project);
    const base = {
      url,
      host: parsed.host,
      project: cleanProject,
      target: parsed.target,
      lines: parsed.lines,
    };

    if (options.resolve === false) {
      // Nothing to match against, so the ref is the first segment: a guess, and
      // labelled as one.
      const parts = resolveUrlParts(parsed.rest, [], parsed.refTypeHint);
      return { ...base, ref: parts.ref, path: parts.path, refConfirmed: false };
    }

    const source = await this.resolveSource(cleanProject);
    await this.refresh(cleanProject, source, "ttl");
    const refs = await this.rawRefs(source, patternsFor("all", source));
    const parts = resolveUrlParts(parsed.rest, refs, parsed.refTypeHint);
    const resolved = await this.resolveWithFreshness(cleanProject, parts.ref, source);
    const syncMs = await this.sources.lastSyncAt(source.gitDir);

    return {
      ...base,
      ref: parts.ref,
      path: parts.path,
      refConfirmed: parts.confirmed,
      refKind: parts.refKind,
      commit: resolved.commit,
      source: source.kind,
      syncedAt: syncMs === undefined ? undefined : new Date(syncMs),
      fetched: resolved.fetched,
      refreshError: resolved.refreshError,
    };
  }

  /**
   * Read each displayed file once, and cut the ranges around its matches.
   *
   * A file is read to the hard byte cap rather than the caller's: context around
   * line 9000 of a 4 MB file is not reachable inside a 200 KB read, and the range
   * is the point. The twenty reads happen one after another — they are local
   * object-store reads, and a burst of them buys nothing but memory.
   */
  private async contextFor(
    source: GitSource,
    commit: string,
    radius: number,
    matches: SearchMatch[],
  ): Promise<MatchContext> {
    const byPath = new Map<string, number[]>();
    for (const match of matches) {
      const lines = byPath.get(match.path);
      if (lines) {
        lines.push(match.line);
      } else {
        byPath.set(match.path, [match.line]);
      }
    }

    const files: FileContext[] = [];
    let read = 0;
    for (const [path, lines] of byPath) {
      if (read >= CONTEXT_MAX_FILES) {
        files.push({
          path,
          lines: [],
          note: `context reads the first ${CONTEXT_MAX_FILES} files; this one shows its matches only`,
        });
        continue;
      }
      read += 1;

      const shown = await this.git.run(["show", `${commit}:${path}`], {
        gitDir: source.gitDir,
        maxBytes: HARD_FILE_MAX_BYTES,
      });
      if (shown.code !== 0) {
        const reason = this.redact(shown.stderr).trim().split("\n")[0] ?? "";
        files.push({
          path,
          lines: [],
          note: reason ? `the file could not be read: ${reason}` : "the file could not be read",
        });
        continue;
      }
      if (shown.stdout.includes("\u0000")) {
        files.push({ path, lines: [], note: "the file is binary, so there are no lines to show" });
        continue;
      }
      if (shown.truncated) {
        files.push({
          path,
          lines: [],
          note: `the file is larger than ${HARD_FILE_MAX_BYTES} bytes, so it was not read for context`,
        });
        continue;
      }

      files.push({ path, lines: contextLines(shown.stdout, lines, radius) });
    }

    return { radius, files };
  }

  /**
   * Search the tree of one ref: `git grep`.
   *
   * The ref is resolved first, with the same freshness rules as a read — and
   * therefore with fetch-on-miss, which a listing cannot use — and the search
   * runs against the resolved commit rather than the name. That is what makes a
   * branch that exists only as a remote-tracking ref work, and what lets the
   * result carry the same `commit`/`syncedAt` provenance as `get_file`.
   *
   * Matching is literal and case-insensitive unless asked otherwise: git's
   * default dialect is BRE, where `|` and `+` are ordinary characters, so a
   * caller's `foo|bar` would quietly match the literal text instead.
   */
  async search(project: string, query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const cleanProject = validateProject(project);
    const cleanQuery = validateQuery(query);
    const cleanPath = options.path === undefined ? undefined : validateRepoPath(options.path);
    const output = options.output ?? "matches";
    const radius =
      options.context === undefined
        ? 0
        : Math.min(Math.max(Math.trunc(options.context), 0), HARD_CONTEXT_RADIUS);

    // Checked before the ref is resolved: a bad pairing should cost nothing, and
    // the two cheap modes have no matched line for context to sit next to.
    if (radius > 0 && output !== "matches") {
      throw new Error(
        `context needs output "matches": "${output}" has no matched lines to put context around.`,
      );
    }

    const source = await this.resolveSource(cleanProject);
    const target = await this.targetRef(source, options.ref);
    const { commit, fetched, refreshError, skipped } = await this.resolveWithFreshness(
      cleanProject,
      target.resolve,
      source,
    );
    if (!commit) {
      throw new NotFoundError(
        await this.notFoundRefMessage(cleanProject, target.display, {
          refreshError,
          skipped,
          sourceKind: source.kind,
        }),
      );
    }

    const args = ["grep", "-z", "-I", "--no-color"];
    // `-l` and `--count` answer the question without emitting a matched line, which
    // is what keeps a broad query cheap — and what keeps its totals exact.
    if (output === "matches") {
      args.push("--line-number");
    } else if (output === "files") {
      args.push("-l");
    } else {
      args.push("--count");
    }
    args.push(options.regex ? "-E" : "-F");
    if (!options.caseSensitive) {
      args.push("-i");
    }
    // `-e` keeps a pattern that starts with `-` from being read as an option.
    args.push("-e", cleanQuery, commit);
    if (cleanPath) {
      args.push("--", cleanPath);
    }

    const found = await this.git.run(args, { gitDir: source.gitDir, maxBytes: SEARCH_MAX_BYTES });
    // Exit 1 is `git grep`'s "nothing matched": an answer, not a failure.
    if (found.code !== 0 && found.code !== 1) {
      throw new GitError(
        `Failed to search "${cleanQuery}" at "${target.display}".`,
        found.code,
        this.redact(found.stderr).trim(),
      );
    }

    const limit = Math.min(options.maxMatches ?? DEFAULT_MAX_MATCHES, HARD_MAX_MATCHES);
    const syncMs = await this.sources.lastSyncAt(source.gitDir);
    const shape = {
      project: cleanProject,
      ref: target.display,
      commit,
      query: cleanQuery,
      regex: options.regex ?? false,
      caseSensitive: options.caseSensitive ?? false,
      path: cleanPath,
      output,
      syncedAt: syncMs === undefined ? undefined : new Date(syncMs),
      fetched,
      refreshError,
    };

    if (output === "files") {
      const paths = parseGrepPaths(found.stdout, commit);
      return {
        ...shape,
        matches: [],
        fileHits: paths.slice(0, limit).map((path) => ({ path })),
        files: paths.length,
        truncated: paths.length > limit || found.truncated,
        outputTruncated: found.truncated,
      };
    }

    if (output === "count") {
      const hits = parseGrepCounts(found.stdout, commit);
      return {
        ...shape,
        matches: [],
        fileHits: hits.slice(0, limit),
        total: hits.reduce((sum, hit) => sum + (hit.count ?? 0), 0),
        files: hits.length,
        truncated: hits.length > limit || found.truncated,
        outputTruncated: found.truncated,
      };
    }

    const parsed = parseGrepMatches(found.stdout, commit);
    const shown = parsed.length > limit ? parsed.slice(0, limit) : parsed;
    return {
      ...shape,
      matches: shown,
      fileHits: [],
      total: parsed.length,
      files: new Set(parsed.map((match) => match.path)).size,
      truncated: parsed.length > limit || found.truncated,
      outputTruncated: found.truncated,
      // Context follows what is displayed, not everything found: reading files the
      // answer cannot show would be work nobody sees.
      context: radius > 0 ? await this.contextFor(source, commit, radius, shown) : undefined,
    };
  }

  /**
   * Commits whose diff changed how many times `query` appears: `git log -S`.
   *
   * This answers a different question from `search` — not "where is this now"
   * but "when did it appear or go away" — and it walks history to answer it, so
   * it is the slower of the two.
   *
   * Like `search`, it ignores case unless asked not to: a pickaxe that is
   * silently case-sensitive answers "no commit ever changed this" about text the
   * caller is looking straight at.
   */
  async pickaxe(
    project: string,
    query: string,
    options: PickaxeOptions = {},
  ): Promise<PickaxeResult> {
    const cleanProject = validateProject(project);
    const cleanQuery = validateQuery(query);
    const cleanPath = options.path === undefined ? undefined : validateRepoPath(options.path);

    const source = await this.resolveSource(cleanProject);
    const target = await this.targetRef(source, options.ref);
    const { commit, fetched, refreshError, skipped } = await this.resolveWithFreshness(
      cleanProject,
      target.resolve,
      source,
    );
    if (!commit) {
      throw new NotFoundError(
        await this.notFoundRefMessage(cleanProject, target.display, {
          refreshError,
          skipped,
          sourceKind: source.kind,
        }),
      );
    }

    const limit = Math.min(options.limit ?? DEFAULT_PICKAXE_LIMIT, HARD_MAX_MATCHES);
    const args = [
      "log",
      `--format=${PICKAXE_FORMAT}`,
      "--date=short",
      // One more than asked, so "there are more" is a fact rather than a guess.
      `--max-count=${limit + 1}`,
      // Joined to `-S`, so a query starting with `-` cannot be read as an option.
      `-S${cleanQuery}`,
      commit,
    ];
    if (!options.caseSensitive) {
      // Verified with git 2.53: `-i` really does apply to `-S`.
      args.push("-i");
    }
    if (cleanPath) {
      args.push("--", cleanPath);
    }

    const found = await this.git.run(args, { gitDir: source.gitDir, maxBytes: SEARCH_MAX_BYTES });
    if (found.code !== 0) {
      throw new GitError(
        `Failed to search history for "${cleanQuery}".`,
        found.code,
        this.redact(found.stderr).trim(),
      );
    }

    const entries = parsePickaxeEntries(found.stdout);
    const syncMs = await this.sources.lastSyncAt(source.gitDir);

    return {
      project: cleanProject,
      ref: target.display,
      commit,
      query: cleanQuery,
      caseSensitive: options.caseSensitive ?? false,
      path: cleanPath,
      entries: entries.length > limit ? entries.slice(0, limit) : entries,
      truncated: entries.length > limit || found.truncated,
      syncedAt: syncMs === undefined ? undefined : new Date(syncMs),
      fetched,
      refreshError,
    };
  }

  // --- internals -----------------------------------------------------------

  /**
   * The ref a read should act on: the one asked for, or the source's HEAD — the
   * mirror's default branch, or a clone's checked-out branch.
   *
   * The display name is the resolved one, so an answer says `develop` rather
   * than `HEAD`, while the name handed to git stays `HEAD` in that case, which
   * is what makes a detached repository work at all.
   */
  private async targetRef(
    source: GitSource,
    ref: string | undefined,
  ): Promise<{ resolve: string; display: string }> {
    const asked = ref?.trim() ? validateRef(ref) : undefined;
    if (asked) {
      return { resolve: asked, display: asked };
    }

    const head = await this.defaultBranch(source.gitDir);
    return { resolve: "HEAD", display: head ?? "HEAD" };
  }

  /**
   * Ensure the source is fresh enough, then resolve the ref. If the ref is not
   * found and we did not just fetch, fetch once more and retry — this is what
   * makes a branch created moments ago appear without a manual sync.
   *
   * `knownSource` lets a caller that already resolved the source (to ask it for
   * its HEAD, say) avoid resolving it twice.
   */
  private async resolveWithFreshness(
    project: string,
    ref: string,
    knownSource?: GitSource,
  ): Promise<ResolvedRef> {
    const cleanProject = validateProject(project);
    const cleanRef = validateRef(ref);
    const source = knownSource ?? (await this.resolveSource(cleanProject));

    const first = await this.refresh(cleanProject, source, "ttl");
    let commit = await this.revParse(source, cleanRef);
    let fetched = first.fetched;
    let refreshError = first.error;

    // Only a *miss* earns a second fetch, and only when policy allows fetching at
    // all. A refresh that failed is not retried either: it would fail the same
    // way, and its reason is worth passing on unchanged.
    if (!commit && !first.fetched && !first.error && !first.skipped) {
      const second = await this.refresh(cleanProject, source, "miss");
      commit = await this.revParse(source, cleanRef);
      fetched = second.fetched;
      refreshError = second.error;
    }

    return {
      source,
      ref: cleanRef,
      project: cleanProject,
      commit,
      fetched,
      refreshError,
      skipped: first.skipped,
    };
  }

  private async revParse(source: GitSource, ref: string): Promise<string | undefined> {
    for (const candidate of refCandidates(source, ref)) {
      const result = await this.git.run(
        ["rev-parse", "--verify", "--end-of-options", `${candidate}^{commit}`],
        { gitDir: source.gitDir, maxBytes: 4096 },
      );
      if (result.code !== 0) {
        continue;
      }
      const commit = result.stdout.trim();
      if (commit) {
        return commit;
      }
    }
    return undefined;
  }

  /**
   * Read every ref under `patterns`.
   *
   * Fields are NUL-separated rather than whitespace-separated so a commit
   * subject can contain anything without corrupting the row.
   */
  private async rawRefs(source: GitSource, patterns: string[]): Promise<RefEntry[]> {
    const result = await this.git.run(
      ["for-each-ref", `--format=${REF_FORMAT}`, ...patterns],
      { gitDir: source.gitDir, maxBytes: REF_MAX_BYTES },
    );
    if (result.code !== 0) {
      throw new GitError(
        "Failed to list refs.",
        result.code,
        this.redact(result.stderr).trim(),
      );
    }

    const refs: RefEntry[] = [];
    const localBranches = new Set<string>();
    for (const line of result.stdout.split("\n")) {
      const [refname, object, peeled, date, peeledDate, subject] = line.split("\u0000");
      if (!refname || !object) {
        continue;
      }

      const named = classifyRef(refname, source.remote);
      if (!named) {
        continue;
      }

      // In a clone the same branch is visible twice, as `refs/heads/x` and as
      // `refs/remotes/<remote>/x`. `for-each-ref` sorts heads first, so the local
      // one — the branch this clone would itself resolve, unpushed commits and
      // all — is kept and its remote twin dropped.
      const fromRemote = refname.startsWith("refs/remotes/");
      if (named.kind === "branch") {
        if (fromRemote) {
          if (localBranches.has(named.name)) {
            continue;
          }
        } else {
          localBranches.add(named.name);
        }
      }

      refs.push({
        name: named.name,
        refname,
        kind: named.kind,
        // An annotated tag's own object id is the tag object; the peeled id is
        // the commit it ultimately points at.
        commit: peeled || object,
        date: peeledDate || date || undefined,
        subject: subject || undefined,
      });
    }
    return refs;
  }

  /** The repository's default branch, as recorded in the source's HEAD. */
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
   * id is never a named ref; branches are checked before tags, matching the
   * existing behaviour when a branch and a tag share a name.
   */
  private async namedRef(
    source: GitSource,
    ref: string,
  ): Promise<{ refname: string; kind: "branch" | "tag" } | undefined> {
    if (/^[0-9a-f]{7,40}$/i.test(ref)) {
      return undefined;
    }

    const candidates: Array<{ refname: string; kind: "branch" | "tag" }> = [
      { refname: `refs/heads/${ref}`, kind: "branch" },
      { refname: `refs/tags/${ref}`, kind: "tag" },
    ];
    if (source.kind === "local" && source.remote) {
      // A branch this clone has not checked out is still a branch, not a bare
      // revision, and the report should say so.
      candidates.push({ refname: `refs/remotes/${source.remote}/${ref}`, kind: "branch" });
    }

    for (const candidate of candidates) {
      const result = await this.git.run(["show-ref", "--verify", "--quiet", candidate.refname], {
        gitDir: source.gitDir,
        maxBytes: 1024,
      });
      if (result.code === 0) {
        return candidate;
      }
    }
    return undefined;
  }

  /**
   * Build the "not found" message for a ref, adding close matches when we can
   * work them out. Suggestions are a nicety: if listing refs fails for any
   * reason the plain message is still the right answer.
   *
   * The message also says when the view behind the answer is out of date — after
   * a failed refresh, or when policy forbade one — because otherwise "not found"
   * reads as proof that the ref does not exist.
   */
  private async notFoundRefMessage(
    project: string,
    ref: string,
    outcome: { refreshError?: string; skipped?: "manual"; sourceKind?: RepoSource } = {},
  ): Promise<string> {
    const suggestions = await this.suggestRefs(project, ref).catch(() => [] as RefEntry[]);
    const base = formatRefNotFound(project, ref, suggestions);
    // A local clone is not a mirror, and saying so in the one message that
    // explains what could not be refreshed is the difference between a clear
    // answer and a confusing one.
    const what = outcome.sourceKind === "local" ? "clone" : "mirror";
    if (outcome.skipped === "manual") {
      return (
        `${base}\nThis project is in \`manual\` freshness mode, so the ${what} was not ` +
        `refreshed. Run \`sync_repo\` to fetch it, then try again.`
      );
    }
    if (!outcome.refreshError) {
      return base;
    }
    return (
      `${base}\nThe ${what} could not be refreshed either, so a ref created since ` +
      `the last sync would not appear here: ${outcome.refreshError}`
    );
  }

  /**
   * The policy for one project: its registry entry's overrides, else the
   * configured default. Resolved in one place so that every caller agrees — two
   * subtly different lookups is how a policy drifts.
   */
  private effectivePolicy(entry: RepoEntry | undefined): {
    mode: FetchMode;
    ttlSeconds: number;
  } {
    return {
      mode: entry?.freshnessMode ?? this.config.fetchMode,
      ttlSeconds: entry?.freshnessTtlSeconds ?? this.config.fetchTtlSeconds,
    };
  }

  private async policyFor(project: string): Promise<{ mode: FetchMode; ttlSeconds: number }> {
    return this.effectivePolicy(await this.registry.get(project));
  }

  /**
   * Remember that a project has a mirror, so `list_repos` can report it.
   *
   * Best effort, deliberately: a registry that cannot be written is a stale
   * listing, not a reason to fail a read that would otherwise have worked.
   */
  private async registerMirror(project: string): Promise<void> {
    try {
      await this.registry.ensure(project, { source: "mirror", cloneStrategy: "full" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[gitlab-mcp] could not record ${project} in the registry: ${this.redact(reason)}\n`,
      );
    }
  }

  /**
   * Where a project is read from, creating its mirror if it has none.
   *
   * A project registered as a local clone is used as it is: a clone is the
   * operator's repository, so it is never cloned by us and never fetched on a
   * timer — only a miss in it, or an explicit `sync_repo`, writes to it.
   *
   * Cloning is network access, so `manual` forbids it as well: for such a project
   * this throws until `sync_repo` is called, the one caller that passes
   * `allowClone`.
   */
  private async resolveSource(
    project: string,
    options: { allowClone?: boolean } = {},
  ): Promise<GitSource> {
    const clean = validateProject(project);
    const entry = await this.registry.get(clean);

    if (entry?.source === "local") {
      return this.sourceFor(clean, entry);
    }

    const dir = this.mirrorPath(clean);
    if (await this.sources.exists(path.join(dir, "HEAD"))) {
      // Registering on use, rather than only on clone, means a mirror created
      // before the registry existed still turns up in `list_repos`.
      await this.registerMirror(clean);
      return { kind: "mirror", gitDir: dir };
    }

    const { mode } = this.effectivePolicy(entry);
    if (mode === "manual" && !options.allowClone) {
      throw new Error(
        `${clean} is in \`manual\` freshness mode and has no mirror yet. ` +
          `Run \`sync_repo\` to fetch it.`,
      );
    }

    await this.sources.cloneMirror(clean, dir);
    await this.registerMirror(clean);
    return { kind: "mirror", gitDir: dir };
  }

  /**
   * Where a registration says a project lives, creating nothing.
   *
   * Throws when a local registration cannot be used; the caller decides whether
   * that is an error (`add_repo` must refuse a bad path) or a `present=false` row
   * (a listing should still show the project, with reads explaining themselves).
   */
  private async sourceFor(project: string, entry: RepoEntry): Promise<GitSource> {
    if (entry.source === "local") {
      if (!entry.localPath) {
        throw new Error(
          `${project} is registered as a local clone with no path recorded. ` +
            `Register it again with \`add_repo\`, or \`remove_repo\` it to fall back to a mirror.`,
        );
      }
      return this.sources.localSource(project, entry.localPath);
    }
    return { kind: "mirror", gitDir: this.mirrorPath(project) };
  }

  /**
   * Whether a source's data is really on disk. A mirror counts when it has a
   * HEAD; a local registration counts when the path holds a usable repository.
   */
  private async sourcePresent(source: GitSource): Promise<boolean> {
    if (source.kind === "local") {
      return this.sources.isRepo(source.workDir ?? source.gitDir);
    }
    return this.sources.exists(path.join(source.gitDir, "HEAD"));
  }

  /**
   * Refresh a source when policy says it is stale.
   *
   * Serialised per source. The decision is re-checked inside the lock so that
   * callers queued behind an in-flight fetch do not fetch again.
   *
   * A failed fetch is reported rather than thrown. A source that cannot be
   * refreshed is still readable, and only the caller can judge whether serving
   * it is the right thing — the answer carries `syncedAt` so its age is visible.
   *
   * @returns whether a fetch actually ran, and why one failed if it did.
   */
  private async refresh(
    project: string,
    source: GitSource,
    reason: RefreshReason,
  ): Promise<RefreshOutcome> {
    const startedAt = Date.now();
    const { mode, ttlSeconds } = await this.policyFor(project);

    // `manual` means the operator decides when this project talks to the network,
    // so not even a miss fetches. The read still answers — `syncedAt` carries its
    // age — and a miss says how to refresh it.
    if (mode === "manual") {
      return { fetched: false, skipped: "manual" };
    }

    // A local clone is not ours to keep fresh on a timer: under `ttl` nothing is
    // fetched there, and only a *miss* justifies writing to someone's repository.
    // `always` is the exception, because that is the operator asking every time.
    if (source.kind === "local" && mode !== "always" && reason === "ttl") {
      return { fetched: false };
    }

    const ttlMs = mode === "always" ? 0 : ttlSeconds * 1000;

    return this.sources.enqueue(source.gitDir, async () => {
      const last = await this.sources.lastSyncAt(source.gitDir);
      if (reason === "ttl") {
        if (last !== undefined && Date.now() - last <= ttlMs) {
          return { fetched: false };
        }
      } else if (last !== undefined && last >= startedAt) {
        // Another caller refreshed while we waited our turn.
        return { fetched: false };
      }

      try {
        await this.sources.fetch(project, source);
        return { fetched: true };
      } catch (error) {
        // Deliberately not retried by the caller: a second attempt would fail
        // the same way and cost another timeout before saying the same thing.
        return { fetched: false, error: describeError(error) };
      }
    });
  }

  /** Remove the token from any text before it reaches a log or tool result. */
  private redact(value: string): string {
    return this.sources.redact(value);
  }
}
