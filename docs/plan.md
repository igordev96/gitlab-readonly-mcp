# GitLab Read-Only MCP Server (git-backed) — Plan

> **This file is the canonical plan.** It lives in the repository at `docs/plan.md`
> and is version-controlled alongside the code. Edit it here.
>
> It describes **what will be and what is**. The record of **what happened** —
> milestones, the findings log, per-phase artifacts and the completed Phase 0
> runbook — lives in [`history.md`](history.md). Keep the two apart: this file
> should not grow as phases land.

Status: phases 0, 1, 2a, 2b, 2c-1, 2c-2 and 4a complete; newest tag `v0.8.0`
(search and pickaxe). Ten tools are implemented: the four reads — exercised
against the real GitLab on the success path and on a deliberately broken token —
`search` and `pickaxe`, plus `list_repos`, `add_repo`, `remove_repo` and
`sync_repo`. A project registers itself the first time it is used, or explicitly
with `add_repo`, and its registry entry decides where it is read from: a mirror
the server keeps fresh, or a clone of your own, which is read, never cloned, and
fetched only when a ref is missing from it. Its policy (`repos.json`) can include
`manual`, which makes no network call that `sync_repo` did not ask for, while its
age always comes from the source's own sync stamp and never from the registry.
The token is supplied by OpenCode's config (`~/.config/opencode/opencode.jsonc`),
not by the shell. See `history.md`.
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

**Diff & history (selected extras)**
- `compare(project, from, to, path?)` — `git diff`.
- `diff_file(project, path, from, to)`.
- `log(project, ref, path?, limit?)`.
- `get_commit(project, sha)`.
- `blame(project, path, ref, lines?)`.

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

`search` output modes and match context (4b, mechanics verified with git 2.53,
2026-10-19):

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

**GitLab URLs (4b).** `parse_gitlab_url(url, resolve?)` returns what a link names,
so a URL can go to a read instead of being decoded by hand; `get_file` and
`list_tree` also accept `url` directly, which is the common case.

- **Shapes.** `/-/blob/<ref>/<path>` and `/-/raw/<ref>/<path>` name a file;
  `/-/tree/<ref>` and `/-/tree/<ref>/<path>` name a directory;
  `/-/blame/<ref>/<path>` names a file (blame itself is phase 3).
  `/-/commit/<sha>`, `/-/commits/<ref>[/<path>]` and `/-/merge_requests/<iid>` are
  recognised and refused by name: they are not a file or a directory, and guessing
  would read something the link did not point at.
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
  reports `resolved="false"`, splitting the ref at the first segment. That is the
  inspection mode for a link whose project should not be touched.
- Parsing is a pure function in `src/url.ts`, unit-tested against URL shapes rather
  than the network; resolving the ref is a store concern, because only the store
  knows the refs.
- Optional configured **default project** so agents can omit it.

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
| 3 | Diff & history: `compare`, `diff_file`, `log`, `get_commit`, `blame` | "What changed between `develop` and `fix/PROJ-7608`?" works |
| 4a | Search: `search` (`git grep`) and `pickaxe` (`git log -S`) | "Where is this used on `fix/PROJ-7608`, and when did it appear?" answered without a clone |
| 4b | Polish: GitLab URLs (`parse_gitlab_url`, `url` on `get_file`/`list_tree`, line anchors), `search` output modes and match context, the `cloneStrategy` refusal, truncation and stale-visibility review | A pasted GitLab blob link reads the file — and the line range it names — with no hand decoding; a broad search answers "how many, in which files" without parsing every match; a policy value nothing honours is refused by name rather than stored and ignored |

> **Status:** phases 0, 1, 2a, 2b, 2c-1, 2c-2 and 4a complete. The newest tag is
> `v0.8.0` (4a: search and pickaxe). 4b — the GitLab URL work, `search` output
> modes and context, and the review — is next; phase 3 (diff and history) follows.
> Per-phase detail: [`history.md`](history.md).

### Source layout

```
src/
  index.ts       # stdio bootstrap
  server.ts      # McpServer + tool registration
  config.ts      # env, host, cache dir, default project, fetch policy
  git.ts         # safe git exec wrapper (array args, no shell)
  gitDiagnostics.ts  # classify git stderr into an actionable hint
  repoStore.ts   # project -> source resolution, refs, trees, freshness policy
  sources.ts     # mirror paths, clone, fetch, per-source lock, the sync clock
  registry.ts    # repos.json: per-project source and freshness policy
  url.ts         # GitLab web URL -> {project, kind, ref, path, lines}   (4b)
  tools/
    result.ts      # shared tool result shapes and error rendering
    files.ts       # get_file, list_tree                            ✅ Phase 2b-2
    refs.ts        # list_refs, resolve_ref                        ✅ Phase 2b-1
    repos.ts       # list_repos, sync_repo, add_repo, remove_repo   ✅ Phase 2c-1/2c-2
    history.ts                                                    (Phase 3)
    search.ts      # search (git grep), pickaxe (git log -S)        ✅ Phase 4a
test/
  fixture.ts     # builds a throwaway "GitLab" (working repo + bare server)
  store.test.ts  # source resolution, guards, freshness, project policy
  registry.test.ts  # the registry file: parsing, persistence, corrupt handling
  local.test.ts  # local-clone sources: reading, misses, path and delete guards
  refs.test.ts   # ref listing, resolution, close matches
  tree.test.ts   # directory listings, the ls-tree parser, rendering
  search.test.ts # grep and log -S: parsers, rendering, fixture reads
  url.test.ts    # GitLab URL shapes, ref resolution, line anchors
  repos.test.ts  # rendering the registry listing
  git.test.ts    # the git wrapper
  gitDiagnostics.test.ts  # git stderr -> actionable hint
  protocol.test.ts   # the MCP surface over an in-memory transport
  startup.test.ts    # the compiled entry point over real stdio
tsconfig.json        # typecheck: src/ + test/, noEmit
tsconfig.build.json  # emit: src/ only -> dist/
```

Tests import `src/` directly and run through `tsx` on Node's built-in test
runner, so no build is needed to get feedback and a stale `dist/` can never be
tested by accident. `npm test` builds first so the compiled entry point is still
covered. See `history.md` for why this shape was chosen.

Stack: TypeScript, `@modelcontextprotocol/sdk`, `zod` for input schemas, Node
child_process `spawn` (array args) for git.

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
