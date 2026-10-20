// The project registry: what the server knows about each project, and the policy
// it should apply to it.
//
// It deliberately holds *policy only* — never a last-fetch time. Freshness lives
// in the mirror's own sync stamp (`mcp-last-sync`), written only after a fetch
// succeeds. A second clock here could disagree with it, which is the class of bug
// the stamp was introduced to end (see `docs/history.md`, 2026-10-18).
import { promises as fs } from "node:fs";
import path from "node:path";

import type { FetchMode } from "./config.js";

/** Where a project's git data is read from. */
export type RepoSource = "mirror" | "local";

/**
 * How much of history a clone carries.
 *
 * Only `full` is supported. `blobless` is parsed and kept rather than rewritten,
 * so a registry edited by hand keeps saying what it says and a read can refuse it
 * by name: coercing it to `full` would claim blobs that are not on disk.
 */
export type CloneStrategy = "full" | "blobless";

/**
 * Per-project registration and policy. Absent fields fall back to configuration,
 * so an entry records only what makes this project different from the default.
 */
export interface RepoEntry {
  source: RepoSource;
  /** The clone to read from when `source` is `local`. */
  localPath?: string;
  cloneStrategy: CloneStrategy;
  /** Overrides `GITLAB_FETCH_MODE` for this project. */
  freshnessMode?: FetchMode;
  /** Overrides `GITLAB_FETCH_TTL_SECONDS` for this project. */
  freshnessTtlSeconds?: number;
}

export const REGISTRY_FILE = "repos.json";
export const REGISTRY_VERSION = 1;

/**
 * Parse a registry body.
 *
 * Returns `undefined` when the file is not the shape we write, so the caller
 * decides what that means rather than the parser guessing. Entries are validated
 * — an entry with an unknown `source` is dropped rather than trusted — but extra
 * keys are carried through, because the file is meant to be hand-editable and a
 * field a later version understands is not ours to discard.
 */
export function parseRegistry(raw: string): Map<string, RepoEntry> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const repos = (parsed as { repos?: unknown }).repos;
  if (typeof repos !== "object" || repos === null || Array.isArray(repos)) {
    return undefined;
  }

  const entries = new Map<string, RepoEntry>();
  for (const [project, value] of Object.entries(repos as Record<string, unknown>)) {
    const entry = value as Partial<RepoEntry> | null;
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if (entry.source !== "mirror" && entry.source !== "local") {
      continue;
    }
    entries.set(project, {
      ...entry,
      source: entry.source,
      // Kept as written, not coerced: the value is what a read refuses on, and the
      // refusal should name what the file says. Anything else is `full`, which is
      // the only strategy this server implements.
      cloneStrategy: entry.cloneStrategy === "blobless" ? "blobless" : "full",
    });
  }
  return entries;
}

/**
 * The registry file: loaded once per process, written atomically, serialised so
 * that two tool calls registering different projects cannot lose one of them.
 *
 * Reads are tolerant. A missing file is the ordinary first-run state, and a file
 * that does not parse is set aside rather than deleted: the only ways it got that
 * way are a hand edit or an interrupted write, and neither deserves a silent
 * discard.
 */
export class RepoRegistry {
  private loaded?: Promise<Map<string, RepoEntry>>;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly cacheDir: string) {}

  filePath(): string {
    return path.join(this.cacheDir, REGISTRY_FILE);
  }

  async get(project: string): Promise<RepoEntry | undefined> {
    return (await this.load()).get(project);
  }

  /** Every entry, ordered by project so that listings are stable. */
  async all(): Promise<Array<{ project: string; entry: RepoEntry }>> {
    return [...(await this.load())]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([project, entry]) => ({ project, entry }));
  }

  /**
   * Register a project that is not known yet. An existing entry is never
   * overwritten: automatic registration of a mirror must not undo an explicit
   * registration, which is exactly what a local-clone entry is.
   */
  async ensure(project: string, entry: RepoEntry): Promise<void> {
    const entries = await this.load();
    if (entries.has(project)) {
      return;
    }
    entries.set(project, entry);
    await this.persist(entries);
  }

  /**
   * Register or update a project, explicitly.
   *
   * The entry is merged over any existing one, so a field the caller did not
   * mention survives: re-pointing a project at a local clone must not quietly
   * reset a hand-written `freshnessMode`. Passing `localPath: undefined` clears
   * it, which is how a project goes back to being mirror-backed.
   */
  async set(project: string, entry: Partial<RepoEntry> & { source: RepoSource }): Promise<void> {
    const entries = await this.load();
    entries.set(project, { cloneStrategy: "full", ...entries.get(project), ...entry });
    await this.persist(entries);
  }

  /** Forget a project. Returns whether it had been registered. */
  async remove(project: string): Promise<boolean> {
    const entries = await this.load();
    if (!entries.delete(project)) {
      return false;
    }
    await this.persist(entries);
    return true;
  }

  private load(): Promise<Map<string, RepoEntry>> {
    this.loaded ??= this.read();
    return this.loaded;
  }

  private async read(): Promise<Map<string, RepoEntry>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath(), "utf8");
    } catch {
      return new Map();
    }

    const parsed = parseRegistry(raw);
    if (parsed) {
      return parsed;
    }

    await fs.rename(this.filePath(), `${this.filePath()}.corrupt`).catch(() => undefined);
    process.stderr.write(
      `[gitlab-mcp] ${REGISTRY_FILE} could not be parsed; kept it as ` +
        `${REGISTRY_FILE}.corrupt and started a new one\n`,
    );
    return new Map();
  }

  private persist(entries: Map<string, RepoEntry>): Promise<void> {
    const payload = `${JSON.stringify(
      {
        version: REGISTRY_VERSION,
        repos: Object.fromEntries([...entries].toSorted(([a], [b]) => a.localeCompare(b))),
      },
      null,
      2,
    )}\n`;

    const write = async (): Promise<void> => {
      await fs.mkdir(this.cacheDir, { recursive: true });
      const tmp = `${this.filePath()}.tmp`;
      await fs.writeFile(tmp, payload, "utf8");
      // Rename is atomic, so a reader sees either the previous registry or this
      // one — never a half-written file.
      await fs.rename(tmp, this.filePath());
    };

    // Chained like the store's per-project fetches: a failed write must not
    // poison the queue for the next one.
    const run = this.writes.then(write, write);
    this.writes = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
