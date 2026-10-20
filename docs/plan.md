# GitLab Read-Only MCP Server (git-backed) — Plan

> **This file is the canonical plan.** It lives in the repository at `docs/plan.md`
> and is version-controlled alongside the code. Edit it here.
>
> It describes **what will be and what is**. The record of **what happened** —
> milestones, the findings log, per-phase artifacts and the completed Phase 0
> runbook — lives in [`history.md`](history.md). Keep the two apart: this file
> should not grow as phases land.

Status: phases 0, 1, 2a, 2b, 2c-1, 2c-2, 3, 4a and 4b are released, and phase 5
(documentation) is done. The newest tag
is `v0.10.0` (diffs and history). Phase 3 was verified live on 2026-10-19.
Sixteen tools are implemented: the four reads
`get_file`, `list_tree`, `list_refs` and `resolve_ref` — exercised against the real
GitLab on the success path and on a deliberately broken token — plus `search`,
`pickaxe`, `parse_gitlab_url`, the history and diff five (`log`, `get_commit`,
`blame`, `compare`, `diff_file`), and `list_repos`, `add_repo`, `remove_repo` and
`sync_repo`.
`get_file`, `list_tree`, `log`, `get_commit` and `blame` also accept a GitLab web
URL — a `/-/blob/`, `/-/raw/` or `/-/blame/` link, a `/-/tree/` link, a
`/-/commit/<sha>` link, or a `/-/commits/<ref>[/<path>]` link — so a link can be
read as pasted, with its `#L12-20` range, instead of being decoded by hand. Each
link kind has one reader, and a link handed to another tool is refused naming the
tool that would read it. A project registers itself the first time it is used, or
explicitly with `add_repo`, and its registry entry decides where it is read from: a
mirror the server keeps fresh, or a clone of your own, which is read, never cloned,
and fetched only when a ref is missing from it. Its policy (`repos.json`) can
include `manual`, which makes no network call that `sync_repo` did not ask for,
while its age always comes from the source's own sync stamp and never from the
registry. The token is supplied by OpenCode's config
(`~/.config/opencode/opencode.jsonc`), not by the shell. See `history.md`.
Owner: igordev96
Author: OpenCode

---

## 1. Goal

A personal, local (stdio) MCP server that lets an AI agent read repository
content from **any branch/tag/commit** of a self-managed GitLab server,
**without disturbing the developer's working tree**, plus diff and history/blame
lookups.

Primary use case:

> "Show me what's inside `index.tsx` on branch `fix/PROJ-7608`, not `develop`."

Secondary use cases (selected):

- Compare two branches / refs (what changed on `fix/PROJ-7608` vs `develop`).
- Commit history and blame for a file or branch.
- Bonus (free with git): repo-wide code search and pickaxe — **done in 4a**.

Backend decision: **git only** (no GitLab REST API), because the selected
features (diff + history/blame + search) are git's strengths and the REST API's
weaknesses on self-managed/free tiers.

---

## 2. Background & constraints

- GitLab is **self-managed at a custom host**, native GitLab MCP is unavailable
  (disabled by admin, or instance older than 18.3).
- Token must be **read-only**. Scope: `read_repository` (clone/fetch) — *not*
  `api`, *not* `write_repository`.
- Token must never be committed, logged, or stored in `.git/config`.
- Single developer, local machine, stdio transport → no server-side auth needed.
- Environment: Windows, Git 2.53, Node 24, npm 11, TypeScript.

### Note worth a 5-minute check

As of 2026, GitLab's **official MCP server is Free tier** and supports
Self-Managed (`Tier: Free, Premium, Ultimate`). If your instance is simply too
old (< 18.3) an upgrade may unlock it for free; if it is a deliberate admin
policy, your custom server is the right call. Off-the-shelf alternatives that
work today with a PAT: `@modelcontextprotocol/server-gitlab` (small),
`zereight/gitlab-mcp` (broad, 86 tools). We proceed with the custom server
because you want a **small, controlled, read-only** surface.

---

## 3. Architecture

### 3.1 Two backing modes

The MCP resolves every project to one of two sources:

| Mode | When | Fetch behavior |
|---|---|---|
| **Managed mirror** (default) | The project is not registered as local | Bare mirror under the cache dir, cloned on first use; fetched per the freshness policy |
| **Local clone** | The project is registered with `add_repo(project, local_path)` | Read through that clone's own git directory; fetched only when a ref is missing, under `always`, or on `sync_repo` — never on the TTL; the working tree is never touched |

A clone is used for the projects you point at one, and only those: nothing scans
the disk for checkouts, so the choice of source is explicit and recorded in
`repos.json`. Mirrors cost disk; a registered clone costs nothing.

### 3.2 Layout

```
%LOCALAPPDATA%\gitlab-readonly-mcp\  # or configured via GITLAB_MCP_CACHE
  repos.json                         # registry: project -> source and policy
  mirrors\
    group\subgroup\repo.git          # bare mirror (mirror mode)
      mcp-last-sync                  # when that mirror last synced successfully
```

`repos.json` is **policy only** — it never records a fetch time (see §3.4):

```jsonc
{
  "version": 1,
  "repos": {
    "group/subgroup/repo": {
      "source": "mirror",            // "mirror" | "local"
      "localPath": null,             // set when source == "local"
      "cloneStrategy": "full",       // "full" only; "blobless" is refused (4b)
      "freshnessMode": "manual",     // overrides GITLAB_FETCH_MODE
      "freshnessTtlSeconds": 600     // overrides GITLAB_FETCH_TTL_SECONDS
    }
  }
}
```

An absent field means "the configured default", so an entry records only what
makes that project different. Writes go through a temp file and a rename, and a
file that does not parse is kept aside as `repos.json.corrupt` rather than
discarded — the only ways it got that way are a hand edit or an interrupted
write. `add_repo` merges into the entry that is already there, so re-pointing a
project at a path cannot quietly reset a hand-written `freshnessMode`; going back
to a mirror clears `localPath` in the same step.

`cloneStrategy` accepts only `"full"` (4b). A file that says `"blobless"` is not
coerced to `"full"` and forgotten: the entry keeps the refused value, `list_repos`
reports it, and using that project fails with a message naming the project, the
value and the fix. A policy nothing honours should be visible, not silently
downgraded — and `blobless` earns its refusal on the merits (see the disk row in
§8).

### 3.3 Ref resolution flow

```
resolve(project, ref):
  1. Build the "git view": the mirror, or a registered clone's git directory
  2. If ref resolves locally -> maybe refresh per freshness policy -> return sha
  3. If ref NOT found locally:
       a. fetch once (mirror, or local clone's remote)
       b. retry resolve
       c. if still missing -> clean "ref not found" error listing close matches
```

Step 3 is what makes a brand-new branch appear without a manual sync. Step 3c is
implemented (`src/repoStore.ts`: `rankSimilar`, surfaced by `resolve_ref` and by
`get_file`'s not-found error).

For a registered clone a bare name is tried twice — as a local ref, then as
`refs/remotes/<remote>/<name>` — because after `git clone` only the checked-out
branch is a local ref and every other branch lives under `refs/remotes/`, where
a bare name never resolves. The local name wins when both exist, so a clone
answers with its own branch, unpushed commits included.

### 3.4 Freshness strategy (core concern)

Mirrors going silently stale is the #1 risk: the agent would confidently cite an
old branch. Mitigations:

1. **Mirror semantics.** `git clone --mirror` sets `remote.origin.mirror=true`,
   so `git fetch` updates all refs **and prunes deleted refs automatically**, and
   honors force-pushes (refspec is forced). Effectively `fetch --prune` for free.
   For non-mirror bare clones we pass `--prune` explicitly.
2. **Per-repo policy** (`freshnessMode`):
   - `ttl` (default): fetch when the last successful sync is older than `ttl`
     (default 600s). A registered local clone is never fetched on the TTL —
     §3.5 says why.
   - `always`: fetch before every read (correct, slower). This is the one mode
     that fetches a clone on a timer, because that is the operator asking.
   - `manual`: nothing fetches by itself — not the TTL refresh, not a miss, not
     even the first-use clone, because each of those is network access the
     operator did not ask for. Only `sync_repo` refreshes such a project, and a
     not-found ref says so instead of reading as proof of absence.
3. **Fetch-on-miss:** an unresolved ref always triggers one fetch + retry.
4. **Visible provenance:** every read result includes the resolved
   `commit_sha` and the source's `synced_at` timestamp, so the response itself
   signals how fresh it is.
5. **Explicit control:** `sync_repo(project)` forces a fetch; `list_repos` shows
   every registered project, its effective policy, and last *sync* times read
   from the stamp, so you can see which are stale.
6. **Concurrency:** serialize fetch per source (a simple in-process lock keyed by
   the git directory) so parallel tool calls don't run overlapping fetches.
7. **Where fetch-on-miss cannot help:** listing refs. A ref that fails to resolve
   is a detectable miss, so we can fetch and retry; a *stale list* is not — a
   branch pushed a minute ago is simply absent, with no signal that anything is
   missing. `list_refs` therefore reports `synced_at` and nothing more, and
   `resolve_ref` remains the way to check one specific ref.

> **Status (implemented):** items 1, 3, 4 and 6; all three modes in item 2, the
> last of them in 2c-1; and item 5's explicit controls (`sync_repo`,
> `list_repos`, and the per-project override in `repos.json`).
>
> Implementation notes:
> - The fetch decision is re-checked *inside* the per-source lock, so callers
>   queued behind an in-flight fetch do not fetch again. The lock is keyed by the
>   git directory, not by the project, so a clone and a mirror never wait on each
>   other.
> - If the TTL step already fetched, a missing ref does not trigger a second
>   fetch; if it did not fetch, the miss triggers exactly one.
> - Policy is resolved in one place — the project's registry entry, else
>   configuration — so the TTL decision, the miss decision and the clone decision
>   cannot disagree with one another.
> - A mirror registers itself the first time it is used, which is why the first
>   `list_repos` on an install that predates the registry lists nothing until a
>   project has been read. Discovery by scanning the cache is deliberately not
>   done: it buys a `registered=false` state and a directory walk to fix a single
>   empty listing. `add_repo` is the explicit way out.
> - The sync clock lives in a stamp file inside the source's git directory
>   (`mcp-last-sync`, epoch ms) and is written **only after a fetch succeeds**,
>   so it survives a restart without a failure ever advancing it. `git clone
>   --mirror` writes no `FETCH_HEAD` (verified), so a clone records itself too.
>   git's own `FETCH_HEAD` is deliberately not trusted: git stamps it before a
>   fetch fails, which made a rejected fetch look like a fresh sync. The registry
>   deliberately holds no copy of that clock — two clocks that can disagree is a
>   bug this project has already paid for. A registered clone keeps *its own*
>   stamp in its own `.git`, so a miss fetched there leaves the mirror's clock
>   untouched; seen live, the two differed by 43 seconds.
> - A refresh that fails does not fail the read. The cached copy answers, and
>   the result reports the reason next to `syncedAt`, so staleness stays visible
>   instead of turning into an outage. A ref that does not resolve through a
>   failed refresh says so — otherwise "not found" would read as proof of
>   absence when all it proves is that the copy is out of date. The wording names
>   a clone as a clone rather than as a mirror.
> - Reading a clone is done through `--git-dir=<clone>/.git` (whatever git
>   reports as its git directory, so linked worktrees work), and a fetch runs
>   with that checkout as its working directory, which is how git finds the
>   repository's own remote configuration. Nothing is ever checked out, stashed
>   or switched: verified live as a byte-identical `git status --porcelain`
>   before and after reads.
> - A local entry's age is measured like a mirror's, from the clone's own stamp;
>   a `list_repos` row for it also checks that the path still holds a usable
>   repository, so a clone that has been moved or deleted reads `present=false`
>   instead of failing the listing.

### 3.5 Local-clone handling

- Registered with `add_repo(project, local_path)` and validated there: the path
  must exist and be a git repository — a normal clone or a bare repo — so a wrong
  path fails at the call that records it rather than at the read that would trust
  it. Every read re-checks it, because a clone can be moved or deleted
  afterwards: the read then names the path that is gone and both ways out
  (`add_repo` again, or `remove_repo` to fall back to a mirror). Nothing falls
  back silently.
- The remote is detected, never assumed: `origin` when the repository has one,
  otherwise the first remote it has. A clone with no remote at all is still
  readable, and a miss in it says *"the registered clone at &lt;path&gt; has no
  remote to fetch from"* rather than a bare "not found".
- No TTL fetch. A fetch happens only for a miss, under `always`, or on
  `sync_repo`.
- Reading through `--git-dir=<clone>` never changes the working tree, so
  uncommitted work is untouched. A fetch on a miss does write to that clone's
  `.git` (new objects, remote-tracking refs, and our sync stamp) — accepted
  deliberately (decided 2026-10-18), because the alternative is a tool that
  cannot see a branch you have not fetched yourself.
- The clone's refs are the clone's: a bare name is tried as a local ref and then
  as `refs/remotes/<remote>/<name>`, `list_refs` lists both namespaces while
  reporting each branch once, and a branch only the remote has is still reported
  as a branch (§3.3).
- `remove_repo(project, delete_mirror?)` forgets the registration and, when asked,
  deletes the mirror — never a local clone, and never anything outside the
  cache's `mirrors` tree. Forgetting a mirror-backed project does not stick (the
  next read registers it again); forgetting a local registration is how a project
  goes back to being read from a mirror.

---

## 4. Tool surface

Tool names are exposed by OpenCode as `gitlab_<tool>`.

**Management**
- `list_repos()` — every registered project, its effective policy, its source
  (`mirror` or `local`, with `local_path`), whether its data is on disk, and its
  last successful sync. ✅
- `add_repo(project, localPath?)` — register a project without touching the
  network: with a path it is read from that clone, without one it goes back to
  being mirror-backed. An existing entry is updated and its policy kept. ✅
- `remove_repo(project, deleteMirror?)` — forget a project, deleting its mirror
  only when asked, and never a local clone. ✅
- `sync_repo(project)` — fetch now, ignoring the TTL and following the project's
  source (a mirror, or the clone's own remote); the only way to refresh a
  `manual` project. ✅ (A `full` re-clone parameter is not implemented; a mirror
  is cloned when it is missing.)

**Reads (core)**
- `get_file(project, ref, path, max_bytes?, url?)` — `git show <ref>:<path>`. ✅
  `url` (4b) substitutes for `project`+`ref`+`path`: a pasted blob or raw link is
  parsed, and a `#L12-20` anchor selects that line range (1-based, inclusive).
- `list_tree(project, ref, path?, recursive?, max_entries?, url?)` — `git ls-tree -l -z`,
  one level deep by default, paths relative to the repository root. ✅ `url` (4b)
  does the same from a `/-/tree/…` link.
- `list_refs(project, kind=branches|tags|all, search?, max_refs?)` — `git for-each-ref`,
  scoped to `refs/heads` + `refs/tags`, plus a registered clone's
  `refs/remotes/<remote>` under `branches`, since that is where every branch but
  the checked-out one lives there. ✅
- `resolve_ref(project, ref)` — sha existence + close matches. ✅
  (Named `ref` rather than the original `name`, to match `get_file`.)

**Diff & history** — phase 3, designed below and split into 3a–3d in §7.
- `log(project, ref?, path?, limit?, url?)` — `git log`, newest first, one row
  per commit (short sha, ISO date, author, subject); a merge commit is marked.
  `ref` defaults to HEAD and is named in the header.
- `get_commit(project, rev, patch?, max_bytes?, url?)` — `git show`: sha,
  parents, author/committer with dates and the full message, then the changed
  files with status and ± counts; `patch: true` appends the unified diff. A merge
  commit says so rather than listing no files and looking empty.
- `blame(project, path, ref?, lines?, max_lines?, url?)` — `git blame` in its
  porcelain format: who last touched each line, grouped into consecutive runs,
  with `lines` narrowing to a range (a `#L12-20` anchor).
- `compare(project, from, to, path?, merge_base?, max_files?)` — a **summary**,
  never a patch: per-file status and ± counts, with the merge base named.
- `diff_file(project, path, from, to, context?, max_bytes?)` — the unified diff
  of one file between two refs; the caller names the file, so no patch header has
  to be parsed to find it.

**Search** — implemented in 4a, `v0.8.0`.
- `search(project, query, ref?, path?, case_sensitive?, regex?, max_matches?, output?, context?)` —
  `git grep` over the tree of one ref, matches grouped by file as
  `path:line: text`, with the same `commit` / `synced_at` provenance as
  `get_file`. ✅
- `pickaxe(project, query, ref?, path?, case_sensitive?, limit?)` — `git log -S`:
  "when was this text introduced or removed?", one commit per line. ✅

`search` design decisions (mechanics verified with git 2.53, 2026-10-18):

- **Grep a SHA, not a ref name.** `git grep <pattern> <rev>` prefixes every match
  with `<rev>:`; when the argument is the SHA we just resolved that prefix is
  exactly known, so it can be stripped rather than guessed — a path may contain a
  colon, and in a clone the ref may be `refs/remotes/origin/…`. It also means a
  ref that exists only as a remote-tracking ref works, and the answer carries the
  same `commit`/`synced_at` provenance as `get_file`.
- **Parse with `-z`, group in threes.** With `-z` git writes
  `ref:path\0line\0text` + newline per match; splitting the raw output on NUL and
  grouping in threes survives a path containing a newline, which splitting on
  lines would not. A torn tail — the stdout byte cap can cut mid-record — is
  dropped.
- **Exit codes are part of the contract.** `git grep` exits 1 when nothing
  matched: an empty answer, not an error. It exits 128 for an unresolvable
  revision, which cannot happen here because the ref is resolved first and a miss
  is reported with close matches. This is why `search` *can* use fetch-on-miss
  where `list_refs` cannot: it resolves one ref rather than listing all of them.
- **Literal by default** (`-F`). The default git dialect is BRE, where `+`, `?`
  and `|` are literal, so an agent writing `foo|bar` would silently get a literal
  match. `regex: true` opts into `-E` — POSIX ERE, not PCRE — and the description
  says so.
- **Case-insensitive by default**, consistent with `list_refs`' `search`: a
  silent miss costs more than a visible extra match. `case_sensitive: true`
  reverses it.
- `-I` skips binary files, `--no-color` is explicit, and the pattern goes through
  `-e <pattern>` so one starting with `-` cannot be read as an option. The
  optional `path` is a git pathspec, passed through as git defines it, so it is
  worth knowing what that means: `src/components/*.tsx` matches, and a plain
  pathspec's `**` requires at least one directory level — `:(glob)src/**/*.tsx`
  is what makes it match zero or more. Both behaviours are pinned by tests, and
  the description says so, rather than the tool inventing a dialect of its own.
- **Caps:** `max_matches` (default 100) with the true total when it is known, and
  the wrapper's own 5 MB stdout cap, which sets `truncated`. Each rendered match
  line is cut at 300 characters and says how much was cut, because one minified
  line can otherwise be a megabyte.
- Display grouping is done in TypeScript rather than with `--heading`: adding
  `-p` changes that format's separator from `:` to `=`, so the format stays ours.

`pickaxe` walks history, so it is slower than `search` and says so in its
description. `limit` (default 20) is passed as `--max-count` one higher than
asked, so "there are more" is a fact rather than a guess, and rows are
`short sha`, `date`, `author`, subject. It is literal (`-S`) in 4a: `-G` — regex
over the patch — answers a different question ("which commits changed a matching
line"), and hiding that difference behind one flag would be a trap. `-S` is
case-sensitive by itself and `-i` does apply to it (verified with git 2.53), so
`pickaxe` runs case-insensitively like `search` unless `case_sensitive` is set:
the live check found the case-sensitive default answering "no commit ever
changed this" about text plainly present on the branch.

`search` output modes and match context (4b, mechanics measured with git 2.53 and
verified live on 2026-10-19):

- **`output: "matches" | "files" | "count"`.** `files` runs `git grep -l -z` and
  `count` runs `git grep -c -z`, because a broad query does not need every matched
  line to answer "how many, and where". The shapes differ, and each was read out of
  the bytes rather than assumed: `-l -z` writes `rev:path\0` per file with **no**
  newlines at all, so its records are NUL-separated; `-c -z` writes
  `rev:path\0count\n`, one pair per file, which is the match layout with the count
  standing where `line` stands and no text. Measured on `data-testid` (682 matches
  in 269 files): 111 KB of matches, 28 KB of paths, 29 KB of counts — so both cheap
  modes stay exact when `max_matches` (or the byte cap) would have cut the match
  list, and there `max_matches` only caps the rows printed while the header still
  reports every file and the true total.
- **`context: N` is assembled in TypeScript, not by git.** After the 4a finding
  that `-p` loses its `=` marker under `-z`, the other two flags were measured too:
  `-C` and `-W` write context lines in exactly the match layout
  (`path\0line\0text`), so after parsing there is no way to tell which line
  matched. Instead, for the matches actually displayed, grouped by file and capped
  at 20 files, the blob is read once with `git show <commit>:<path>` — the same
  read path as `get_file` — and `N` lines either side of each match are printed
  with the matched line marked `>`. Overlapping ranges merge, distant ones are
  separated by `…`, and a file whose read is capped says so rather than going
  quiet. `N` defaults to 0, which leaves 4a's output untouched.

**Ergonomics**

**GitLab URLs (4b, extended by 3d).** `parse_gitlab_url(url, resolve?)` returns what
a link names, so a URL can go to a read instead of being decoded by hand;
`get_file`, `list_tree`, `log`, `get_commit` and `blame` also accept `url` directly,
which is the common case.

- **Shapes.** `/-/blob/<ref>/<path>` and `/-/raw/<ref>/<path>` name a file;
  `/-/tree/<ref>` and `/-/tree/<ref>/<path>` name a directory;
  `/-/blame/<ref>/<path>` names a file; `/-/commit/<sha>` names a commit;
  `/-/commits/<ref>[/<path>]` names a history with an optional pathspec. Merge
  requests, issues and the rest stay recognised and refused by name: they are not
  version-control objects, and guessing would read something the link did not point
  at.
- **One reader per shape, and no quiet fallback.** `get_file` reads a file link,
  `list_tree` a directory, `get_commit` a commit, `log` a history, and `blame` a
  file link (its `#L118-126` anchor narrowing the blame). A link handed to another
  tool is refused naming the tool that reads it — `"…" is a commit link; use
  get_commit for it.` — and the check runs before anything is resolved, so a link
  never turns into a read of something it did not point at.
- **A commit link names no path**, so its rendering carries no `path` attribute and
  no "the path may have lost part of it" note; `ref` is the revision, and whether
  that revision exists is answered by `commit` rather than by `ref_confirmed` (a sha
  is not a ref of the project, so `ref_confirmed="false"` is expected there).
- **The project** is everything before the first `/-/`; a trailing `.git`, a
  trailing slash, `?query` and `#fragment` are stripped. **The host must equal
  `GITLAB_HOST`** (scheme and case ignored): a link to another instance is refused
  with both hosts named, rather than reading a same-named project here.
- **A ref may contain slashes.** `/-/blob/fix/PROJ-7608/src/index.tsx` has three
  plausible splits, so the remainder is matched against the source's actual refs
  (`for-each-ref`, no fetch) and the **longest** known ref that is a prefix —
  followed by `/` or the end — wins, which is the greedy resolution GitLab itself
  does. `?ref_type=tags` prefers a tag when one name is both. With no match, the
  first-segment reading is used and the read fails with the usual not-found message
  and close matches, so a link never turns into a confident guess.
- **Line anchors.** `#L12`, `#L12-20` and `#L12-L20` become `lines: {from, to}`,
  and `get_file` renders exactly that range (1-based, inclusive): the point of
  pasting a link is that it already points at the lines.
- `resolve: false` parses **offline** — no registry, no mirror, no network — and
  splits the ref at the first segment, reporting `ref_confirmed="false"` and a
  `[not resolved: …]` note. That is the inspection mode for a link whose project
  should not be touched.
- Parsing is a pure function in `src/url.ts`, unit-tested against URL shapes rather
  than the network; resolving the ref is a store concern, because only the store
  knows the refs.
- Optional configured **default project** so agents can omit it.

`compare`, `diff_file`, `log`, `get_commit` and `blame` design (phase 3,
mechanics measured with git 2.53 on 2026-10-19):

- **`compare` is three-dot by default.** `git diff <merge-base(from,to)> <to>`
  answers "what changed on `to` since it split from `from`", which is the question
  a branch comparison actually asks; the base comes from `git merge-base` and is
  printed as `merge_base=<sha>`, so which diff ran is never hidden.
  `merge_base=false` asks for the raw two-dot diff (`git diff from to`) — "what
  would applying this do". Both refs are resolved to commits first and both shas
  are printed.
- **A summary, never a patch.** A branch diff is unbounded — thousands of files
  and megabytes of patch — so a tool answer that silently truncates to the byte
  cap is worse than a summary that says it was capped. `compare` prints per-file
  status and ± counts (`M`, `A`, `D`, `R091 old -> new`), capped by `max_files`
  (default 100, hard 1000) with a footer; `diff_file` is how one file's patch is
  read.
- **Status and counts need two commands, because the flags do not combine.**
  Measured: `git diff --numstat --name-status` prints only the name-status section
  (the last flag wins), so the file list costs two passes over the same diff —
  `--name-status -z -M` for status and rename pairs, `--numstat -z -M` for counts,
  zipped by path. The commit header is suppressed with an empty `--format=`, not
  with `--no-patch`: the latter *is* `-s`, which git refuses to combine with
  `--name-status`. `--numstat -z` has a trap of its own: a rename record is
  `add\tdel\t\0old\0new\0`, with an **empty** path field and the two names after
  it, so a parser that assumes three fields reads the old name as the path.
- **Renames are always asked for** (`-M`), so detection does not depend on the
  user's `diff.renames`. Measured: the same rename is `R091\0big.txt\0big2.txt\0`
  in `--name-status -z` and `1\t1\t\0big.txt\0big2.txt\0` in `--numstat -z`, and
  `-M` still finds it with `diff.renames=false`. **A pathspec narrows rename
  detection with it**: `-- big2.txt` (the new name only) reports 20 additions
  instead of the rename, and `-- big.txt` reports 20 deletions. That is git's
  behaviour; the tool description says so rather than pretending otherwise.
- **`-z` also means raw paths.** It disables path quoting, so a non-ASCII path
  arrives as UTF-8 bytes rather than as escapes, and a path containing a newline
  survives — the same reason `search` parses NULs.
- **`diff_file` never parses the patch to find the path.** The caller names the
  file, so `git diff -M <from> <to> -- <path>` is scoped before it runs, and a
  path containing a newline cannot forge a `diff --git` header it was never asked
  about. Context is `-U<N>` (default 3, 0–10), output is capped like `get_file`,
  and a binary file is refused with the same wording — git prints only a
  "Binary files … differ" line, which is not a patch.
- **`log` walks one ref and shows commits, not diffs.** One row per commit, newest
  first: short sha, ISO date, author, subject, `(merge)` for a commit with more
  than one parent. `limit` defaults to 20 (hard 200). There is no cheap total, so
  a capped answer says "showing the most recent N" rather than inventing one — the
  rule `pickaxe` already follows. `path` is a git pathspec, so history stops at a
  rename (no `--follow`: it accepts exactly one path and walks renames backwards,
  so its rows can name paths the ref no longer has — recorded as a limit, not a
  feature).
- **`get_commit` is metadata first.** `git show --format=…` for sha, parents,
  author/committer with dates and the full message, then the same two-pass
  status/count file list as `compare`; `patch: true` appends `git show`'s own
  `--patch` output under the byte cap. A **merge commit** reports `merge="true"`,
  its parents, and a note pointing at `compare <parent> <sha>` instead of a file
  list: git shows no diff for a merge by default, and an empty list without that
  sentence reads as "this commit changed nothing". The parameter is `rev` rather
  than `sha` because an abbreviated sha, a full sha and a ref name are all useful,
  and the header prints both what was asked for and the resolved full sha.
- **`blame` groups by commit.** `git blame --porcelain` emits a full metadata
  block once per commit and only `<sha> <orig> <final> [<count>]` for the lines
  that follow it, so the parser caches metadata per sha and merges consecutive
  lines into one row with a range (measured: a 3-line file from one commit is one
  block with a group size of 3, then two bare headers; a 1-line group has a size
  of 1). Rows print short sha, author, date, the line range, then the lines
  themselves; `lines` narrows the blame (`-L from,to`, from a `#L12-20` anchor)
  and `max_lines` (default 500, hard 5000) caps the rows with a footer. `boundary`
  (the root commit) and `previous <sha> <path>` (a moved line) are read but not
  printed yet. Blame on a **binary** file succeeds in git and yields lines
  containing NUL bytes (measured, exit 0), so `blame` refuses binaries up front
  with the same wording as `get_file` instead of emitting control bytes.
- **Provenance, as everywhere else.** All five resolve their refs through the same
  store path, so they inherit fetch-on-miss, carry `commit` (the resolved sha, or
  both shas and the merge base for a comparison) and `synced_at`, and report
  `refresh_failed="true"` instead of failing when a refresh fails. `compare`
  resolves the source once and then each ref through the existing miss rule, so
  two refs missing from the source can cost two fetches, not one re-plan.

Every read result includes: `commit_sha`, `synced_at`, and for text files a
truncation flag when output is capped.

4b **reviews** that promise rather than extending it: for every tool, that a capped
answer says it was capped and reports the total it knows; that `synced_at` is the
source's own stamp on every path (a mirror, a clone, `manual`, a failed refresh);
and that nothing falls back silently — including a registry value nothing honours
(`cloneStrategy`, §3.2). The output is a findings row in `history.md` per issue
found, and a code change only where a check fails.

---

## 5. Security & hardening

- Token from `GITLAB_TOKEN` env only. Never in config, logs, or error strings.
- **Auth mechanism (verified the hard way — see the findings log in `history.md`):** `PRIVATE-TOKEN` is a
  **REST API** header and is **ignored by git-over-HTTPS**, which returns 401 and
  then prompts for Basic credentials. For git, send standard HTTP auth:
  - Primary: `-c http.extraheader="Authorization: Basic <base64(oauth2:<token>)>"`
  - Alternative: `-c http.extraheader="Authorization: Bearer <token>"`
  - Also pass `-c credential.helper=` so no helper (e.g. Git Credential Manager)
    intercepts and prompts, and `GIT_TERMINAL_PROMPT=0` so it fails fast.
  - Injecting the header per invocation keeps the token **out of
    `.git/config`**.
- **Never embed the token in the remote URL for managed mirrors.** The
  `https://<user>:<token>@host/...` form works on GitLab but persists the token
  in plaintext in `.git/config` and in shell history. It is acceptable only for
  throwaway Phase 0 testing. Managed mirrors keep a clean remote URL and receive
  the header at fetch time.
- **Argument-injection guard:** pass args as an array (no shell); reject
  refs/paths starting with `-`; use `--` separators where applicable.
- **A pasted URL is input, not authority (4b):** the project path is checked
  before it becomes an argument, a ref or path starting with `-` is still rejected
  after parsing, and the link's host must equal `GITLAB_HOST` first — so a link to
  another instance cannot direct a read at a same-named project here.
- `GIT_TERMINAL_PROMPT=0` so a bad token fails fast instead of hanging the MCP.
- `--no-pager`; `-c core.longpaths=true` (Windows).
- Output caps: refuse/flag binary files; truncate large text with an explicit
  marker and byte count.
- Per-server timeout configured in OpenCode (`mcp.timeout`) so a slow clone does
  not appear to hang forever.
- Prefer a **Project Access Token** (role Reporter, `read_repository`) over a
  personal PAT: revocable, least-privilege, not tied to your account.
  *(Phase 0 currently uses a personal PAT; verify its scope is `read_repository`
  and consider switching to a project token before wider use.)*

---

## 6. Windows / git gotchas checklist

- [ ] Leading-`-` arg injection blocked.
- [ ] `GIT_TERMINAL_PROMPT=0` set.
- [ ] `--no-pager` set.
- [ ] `core.longpaths=true`.
- [ ] Internal CA handled via `http.sslCAInfo` / `GIT_SSL_CAINFO` if needed.
- [ ] Token in `http.extraheader` with `Authorization: Basic|Bearer`, **not**
      `PRIVATE-TOKEN`, and not in the remote URL.
- [ ] `-c credential.helper=` clears helpers so nothing prompts/persists.
- [ ] Mirror fetch prunes deleted refs (mirror mode) / `--prune` (bare mode).
- [ ] Binary + huge file handling.
- [ ] Path separators and long paths on Windows.

---

## 7. Build phases

| Phase | Deliverable | Exit criterion |
|---|---|---|
| 0 | Manual plumbing proof (see `history.md`, Phase 0 runbook) | `git show fix/PROJ-7608:src/index.tsx` prints the file |
| 1 | MCP skeleton: stdio + `get_file`, wired into OpenCode | Agent reads a file from `fix/PROJ-7608` via MCP |
| 2a | Freshness: TTL + fetch-on-miss, per-project fetch lock, `synced_at` provenance | A branch pushed minutes ago is readable; every read reports how fresh it is |
| 2b-1 | `list_refs`, `resolve_ref`, close-match hints | Agent can find and confirm a branch before reading it |
| 2b-2 | `list_tree` | Agent can browse a tree it never cloned |
| 2c-1 | Registry: `list_repos`, `sync_repo`, per-project policy, `manual` mode | The registry reports every project in use and its true age; a `manual` project is refreshed only by `sync_repo` |
| 2c-2 | Local clones: `add_repo`, `remove_repo`, mirror+local resolution | A registered clone answers reads with no mirror created for it, fetches only what it lacks, and nothing falls back silently |
| 3a | History: `log`, `get_commit` | "What happened on this branch, and what did that commit touch?" answered without a clone, and a merge commit says so rather than looking empty |
| 3b | `blame` | "Who last touched lines 118–126 of this file, and when?" answered at any ref, including a range taken from a link |
| 3c | Diffs: `compare`, `diff_file` | "What changed between `develop` and `fix/PROJ-7608`?" answered as a capped summary with rename status, and one file's patch readable under a byte cap |
| 3d | Links and release: `/-/commit/`, `/-/commits/` and `/-/blame/` links accepted by the tools that make them readable; docs; `v0.10.0` | A pasted commit or blame link works with no hand decoding, and the phase is released |
| 4a | Search: `search` (`git grep`) and `pickaxe` (`git log -S`) | "Where is this used on `fix/PROJ-7608`, and when did it appear?" answered without a clone |
| 4b | Polish: GitLab URLs (`parse_gitlab_url`, `url` on `get_file`/`list_tree`, line anchors), `search` output modes and match context, the `cloneStrategy` refusal, truncation and stale-visibility review | A pasted GitLab blob link reads the file — and the line range it names — with no hand decoding; a broad search answers "how many, in which files" without parsing every match; a policy value nothing honours is refused by name rather than stored and ignored |
| 5 | Documentation: the README as the user's entry point, `docs/internals.md` for behaviour, `docs/development.md` for build/test/release, and one home per fact | Newcomers install, configure and find what to ask for without reading the design or the release ritual; every semantic fact has one prose home plus the code, and the README's examples are the output the tools actually print |

> **Status:** phases 0, 1, 2a, 2b, 2c-1, 2c-2, 3, 4a and 4b are released, and phase
> 5 (documentation) is done. Phase 3 was verified live on 2026-10-19, including the
> link shapes 3d added; the newest tag is `v0.10.0`. Phase 5 changes no server
> behaviour, so it takes no release. The
> design, including what was measured, is the section before this table, and each
> step's outcome is recorded in [`history.md`](history.md).

### Source layout

The `src/` and `test/` tree, with what each file owns, is kept in
[`development.md`](development.md), beside the build and test instructions it
belongs with. There is one copy, so it cannot drift from the code's own shape.

Stack: TypeScript, `@modelcontextprotocol/sdk`, `zod` for input schemas, Node
child_process `spawn` (array args) for git.

### Tooling

`oxfmt` formats and `oxlint` lints, both as devDependencies; `tsc --noEmit`
stays the type checker and `node:test` the test runner. Both are pinned exactly,
because both are pre-1.0: a minor bump must not be able to change what the
repository's own scripts produce inside unrelated work.

Two settled choices, with the evidence that settled them:

- **`printWidth: 100`.** At 80 the first pass changed 2760 lines; at 100 it
  changed 574. The 81–100 band was accumulated drift rather than a style, and
  80 would have rewrapped nine hundred lines to punish nobody in particular.
- **Markdown is out of scope** (`ignorePatterns: ["**/*.md"]`). Oxfmt pads table
  cells to uniform width and rewrites config examples inside fences — churn in
  the docs, not in the code. The docs are hand-wrapped deliberately.

Linting follows the same shape: `correctness` at error, `suspicious` at warning,
and no `--deny-warnings` until the warning count is zero and stays there. The
`import` and `node` plugins are on because they are the two with signal for a
process-spawning Node CLI; `--type-aware` is off, because `tsc --noEmit` already
answers that question and a second type engine can only disagree with the first.

Three rules about the rule set itself:

- **A suppression is per line and carries its reason.** Five exist: the four
  `no-control-regex` guards — NUL and newlines in a ref, a path or a query, plus
  the stripper for git's `-z` records — and one `new Array<number>` that
  pre-allocates a Levenshtein row. The rules stay on for everyone else.
- **`no-shadow` and `consistent-function-scoping` are off for `test/**` only.**
  A helper named `store` or `client` reads better beside its test than an
  invented second name does. In `src/` they stayed on, and that is where the one
  real finding was: four `path` locals shadowing the `node:path` import.
- **`reportUnusedDisableDirectives` is on**, so a suppression that stops being
  needed is reported rather than rotting into a lie.

The lint config is `.jsonc` rather than `.json` for a single reason: the
`overrides` block has to say why it exists, and a comment beside the decision is
the only place that survives.

Deferred deliberately, so nobody re-litigates it by accident:

- **Commit hooks** (husky, lint-staged, commitlint). A hook is a commit-time
  gate that `--no-verify` bypasses and that a fresh clone does not have until
  `npm install`. CI is the better gate; see below.
  commitlint is the only piece with standalone value, because `AGENTS.md`
  already requires Conventional Commits.
- **A registry or a published package.** `bin` plus a tarball removes the
  absolute path from every config without putting a second credential on every
  machine; a private registry adds only version resolution.

No gate enforces formatting today; the CI section below is where that changes.
Until it lands, `npm run format` is voluntary and a reformat arrives as its own
commit — never inside a change that does something.

### CI (GitHub Actions)

Planned, not yet implemented. GitHub is where the repository lives, so the
workflow is `.github/workflows/ci.yml`.

One job, on `ubuntu-latest`, with the Node version read from `.nvmrc`:

```powershell
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test             # builds first
npm run check:pack   # asserts the tarball contains dist/index.js
```

That is the local gate, run on a machine that has none of the local machine's
state: no global npm packages, no inherited git config, no cached `dist/`. What
it buys is the clean room and the record — not a lock, since on a one-person
repository the checks run *after* the push.

Why one job rather than a matrix: breadth is not depth. A Windows leg and a
second Node column are each a one-line change, and neither answers a question
worth asking today — the server is developed and run on one OS, and Node 26 is a
week from LTS rather than a version anyone has used. Add either when there is a
reason: a second machine in use, or a bug that reproduces away from Windows.

`check:pack` is the part that earns the file. It asserts the shape of the
tarball: `dist/` plus the metadata npm always adds, and nothing else. It needs
`files: ["dist"]` in `package.json` first — without that field npm 11.19 packed
79 files, and `dist/index.js` was among them, so the entry point was never the
problem. Shipping `src/`, `test/`, `docs/` and the tool configuration was. The
script landed first and was watched failing, then the field made it pass: a
check that has never been red is indistinguishable from one that does nothing.

Decisions rather than template defaults:

- **`permissions: contents: read`** at the top. Nothing here writes.
- **`concurrency`** keyed on workflow and ref, `cancel-in-progress: true`, so a
  branch's superseded run is abandoned rather than paid for.
- **Actions by major tag** (`checkout@v7`, `setup-node@v7`), not a commit SHA: a
  SHA pin is stricter and makes a human the only updater, while Dependabot's
  `github-actions` ecosystem is an update path this repository will keep up
  with.
- **`npm ci`**, not `npm install`: it refuses when the manifest and the lockfile
  disagree, which alone would have caught the engine bump arriving without its
  lockfile copy.

**Landing order**, two reviewable steps and one optional:

1. `scripts/check-pack.mjs` plus `npm run check:pack`; red, then
   `files: ["dist"]`; green. Runnable locally, like every other gate here.
2. `.github/workflows/ci.yml`, whose first live run is the push that adds it.
3. Optionally, Dependabot: `npm` weekly (the exact oxfmt and oxlint pins mean
   updates arrive as reviewable PRs, which is the intent) and `github-actions`
   weekly.

Not in this phase: requiring the checks before merge, a tag-triggered release
job (releases are made by hand, see *Versioning*), the Windows leg and the Node
26 column. Each has a trigger named above, so none needs re-deciding from
scratch.

### Versioning

The version the server reports to clients is read from `package.json`, and the
rule is that it equals the newest tag. A release is made by hand — bump
`package.json` and `package-lock.json`, commit `chore(release): X.Y.Z`, then an
annotated `vX.Y.Z` tag — rather than with `npm version`, so that the bump is a
reviewable commit like any other. `test/startup.test.ts` asserts that the
compiled server reports exactly `package.json`'s version, which is what makes the
rule enforced rather than remembered.

> The drift that prompted this rule is recorded in `history.md` (findings log).

### OpenCode wiring (Phase 1)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "gitlab": {
        "type": "local",
        "command": ["node", "C:\\absolute\\path\\to\\dist\\index.js"],
        "environment": {
          "GITLAB_HOST": "https://<GITLAB_HOST>",
          "GITLAB_TOKEN": "{env:GITLAB_TOKEN}",
          "GITLAB_MCP_CACHE": "{env:LOCALAPPDATA}/gitlab-readonly-mcp"
        }
      }
    }
  }
}
```

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Silently stale mirrors | TTL/always/manual policy, fetch-on-miss, visible `synced_at` + `commit_sha` |
| Internal CA blocks TLS | Resolve in Phase 0 before writing code |
| Large repos / disk | A partial (`blobless`) clone was considered and **dropped in 4b**: grep, `git show` and pickaxe's patches all need blob contents, so a blobless source would fetch blobs over the network — with credentials — during a read, which is the property this server exists to avoid. The disk answer is a registered local clone. |
| Unbounded diffs | `compare` returns a capped summary and never a patch; `diff_file` is one file at a time, with a byte cap and a context limit |
| Token leakage | env + `http.extraheader`, never logged, read-only scope |
| Command injection via ref/path | array args, reject leading `-`, `--` separators |
| Fetch stalls MCP | `GIT_TERMINAL_PROMPT=0`, per-project fetch lock, OpenCode timeouts |
| Repo already local | Read-only; never mutate working tree |

---

## 9. Out of scope (for now)

- Write operations (create/edit files, comment on MRs) — would need `api` scope.
- Merge request review and CI/pipeline logs — REST API features; revisit later
  behind the same server as an optional second backend.
- Shared/multi-user hosting — would require HTTP transport and real auth.
- Other git hosts (GitHub/Bitbucket) — git layer is host-agnostic, but nothing
  GitLab-specific beyond the URL parser.
