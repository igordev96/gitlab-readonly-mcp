// GitLab web URLs: what a pasted link names.
//
// Pure on purpose — no registry, no git, no filesystem. Parsing a link and
// *resolving* it are different jobs: only the store knows a project's refs, so
// splitting `/-/blob/fix/PROJ-7608/src/index.tsx` into a ref and a path is the
// store's call. This file says what the link looks like, and how to choose among
// the refs it is handed.

/** A link names a file or a directory. Anything else is refused, never guessed at. */
export type UrlTarget = "file" | "directory";

/** 1-based and inclusive. */
export interface LineRange {
  from: number;
  to: number;
}

/** A ref as the store knows it: structurally a `RefEntry`, without importing one. */
export interface RefName {
  name: string;
  kind: "branch" | "tag";
}

export interface ParsedGitlabUrl {
  /** Lower-case host, without a port. */
  host: string;
  project: string;
  target: UrlTarget;
  /**
   * Ref and path, still glued together: `fix/PROJ-7608/src/index.tsx` cannot be
   * split without knowing which refs exist. See `resolveUrlParts`.
   */
  rest: string;
  /** From a `#L12` / `#L12-20` anchor, when the link carries one. */
  lines?: LineRange;
  /** `?ref_type=tags` or `heads`, as a preference when one name is both. */
  refTypeHint?: "branch" | "tag";
}

export interface UrlParts {
  ref: string;
  path: string;
  /** True when `ref` is a ref the project actually has. */
  confirmed: boolean;
  refKind?: "branch" | "tag";
}

/** Link kinds that are perfectly valid GitLab, but not a file or a directory. */
const OTHER_LINKS: Record<string, string> = {
  merge_requests: "a merge request",
  issues: "an issue",
  epics: "an epic",
  snippets: "a snippet",
  pipelines: "a pipeline",
  jobs: "a job",
  wikis: "a wiki page",
  activity: "an activity feed",
  graphs: "a graph",
  settings: "a settings page",
  edit: "an edit page",
  raw_path: "an internal path",
};

/**
 * Parse a GitLab web URL. Throws with an actionable message for anything that is
 * not a file or directory link, so a link to a pipeline says so instead of
 * quietly reading something else.
 *
 * `expectedHost` is `GITLAB_HOST`. A link to some other instance is refused:
 * project paths are only unique within an instance, so accepting the path alone
 * could read a same-named project here.
 */
export function parseGitlabUrl(input: string, expectedHost: string): ParsedGitlabUrl {
  // A link pasted from chat or Markdown often arrives wrapped or quoted.
  const raw = input
    .trim()
    .replace(/^[<"'`]/, "")
    .replace(/[>"'`]$/, "")
    .trim();
  if (!raw) {
    throw new Error("URL must not be empty.");
  }

  // `""` is a real answer for a `file://` URL — which only the tests use, since
  // `config.ts` requires an http(s) GITLAB_HOST — so only a parse failure is
  // `undefined`.
  const wanted = hostOf(expectedHost);
  if (wanted === undefined) {
    throw new Error(
      `GITLAB_HOST ("${expectedHost}") is not a URL, so a link cannot be checked against it.`,
    );
  }

  let url: URL;
  try {
    // A pasted link usually has a scheme; accept one without, rather than
    // refusing the common case of copying the middle of a link.
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error(`Not a URL: ${JSON.stringify(raw)}.`);
  }

  const host = url.hostname.toLowerCase();
  if (host !== wanted) {
    throw new Error(
      `URL host "${url.hostname}" does not match GITLAB_HOST ("${wanted}"); ` +
        "a link to another GitLab is not read here.",
    );
  }

  // `new URL` keeps percent-escapes, and a path with a space arrives as `%20`.
  const pathname = safeDecode(url.pathname).replace(/^\/+|\/+$/g, "");
  const marker = pathname.indexOf("/-/");
  if (marker === -1) {
    throw new Error(
      `"${raw}" is not a file or directory link (it has no "/-/"). ` +
        "GitLab file links look like /<project>/-/blob/<ref>/<path>; " +
        "a clone URL names a repository, not a file.",
    );
  }

  const project = pathname.slice(0, marker).replace(/\.git$/i, "");
  if (!project) {
    throw new Error(`"${raw}" names no project.`);
  }

  const rest = pathname.slice(marker + 3);
  const slash = rest.indexOf("/");
  const segment = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
  const tail = slash === -1 ? "" : rest.slice(slash + 1);

  if (!tail) {
    throw new Error(
      segment === "tree"
        ? `"${raw}" names no ref: a tree link needs /-/tree/<ref>.`
        : `"${raw}" names no ref and no path.`,
    );
  }

  if (segment === "commit" || segment === "commits") {
    throw new Error(
      `"${raw}" is a commit link, not a file or directory: it names no path. ` +
        "Read the file with `ref` and `path`, or resolve the revision with `resolve_ref`.",
    );
  }

  const other = OTHER_LINKS[segment];
  if (other) {
    throw new Error(`"${raw}" is ${other} link, not a file or directory.`);
  }

  if (segment !== "blob" && segment !== "raw" && segment !== "blame" && segment !== "tree") {
    throw new Error(
      `"${raw}" is not a file or directory link ("/-/${segment}/" is not something ` +
        "this server reads). Accepted: /-/blob/, /-/raw/, /-/tree/ and /-/blame/.",
    );
  }

  const refType = url.searchParams.get("ref_type")?.toLowerCase();
  return {
    host,
    project,
    target: segment === "tree" ? "directory" : "file",
    rest: tail,
    lines: parseLineAnchor(url.hash),
    refTypeHint: refType === "tags" ? "tag" : refType === "heads" ? "branch" : undefined,
  };
}

/** `#L12`, `#L12-20` and `#L12-L20` — anything else (a heading anchor) is ignored. */
export function parseLineAnchor(hash: string): LineRange | undefined {
  const match = /^#?L(\d+)(?:-L?(\d+))?$/i.exec(hash.trim());
  if (!match) {
    return undefined;
  }
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < 1) {
    return undefined;
  }
  return from <= to ? { from, to } : { from: to, to: from };
}

/**
 * Split a URL's glued ref-and-path using the refs the project actually has, which
 * is the only way to read `fix/PROJ-7608/src/index.tsx` unambiguously.
 *
 * The longest matching ref wins, because that is the resolution GitLab itself
 * performs; `hint` (from `?ref_type=`) only breaks a tie between a branch and a
 * tag of the same name. With no match, the first segment is a *guess*: it is
 * reported as unconfirmed, so the caller's read fails with the usual close-match
 * suggestions rather than reading the wrong thing confidently.
 */
export function resolveUrlParts(
  rest: string,
  refs: RefName[],
  hint?: "branch" | "tag",
): UrlParts {
  const trimmed = rest.replace(/^\/+|\/+$/g, "");
  const matches = refs.filter(
    (ref) => trimmed === ref.name || trimmed.startsWith(`${ref.name}/`),
  );

  if (matches.length > 0) {
    const rank = (kind: "branch" | "tag"): number =>
      kind === hint ? 0 : kind === "branch" ? 1 : 2;
    matches.sort((a, b) => b.name.length - a.name.length || rank(a.kind) - rank(b.kind));
    const best = matches[0];
    if (best) {
      return {
        ref: best.name,
        path: trimmed.slice(best.name.length).replace(/^\/+/, ""),
        confirmed: true,
        refKind: best.kind,
      };
    }
  }

  const slash = trimmed.indexOf("/");
  return {
    ref: slash === -1 ? trimmed : trimmed.slice(0, slash),
    path: slash === -1 ? "" : trimmed.slice(slash + 1),
    confirmed: false,
  };
}

/** The host of a configured URL like `GITLAB_HOST`, lower-case and without a port. */
export function hostOf(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
      .hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Decode a percent-escaped path, keeping it verbatim when it is malformed. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
