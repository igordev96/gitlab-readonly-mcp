# GitLab Read-Only MCP Server (git-backed) — Plan

> **This file is the canonical plan.** It lives in the repository at `docs/plan.md`
> and is version-controlled alongside the code. Edit it here.
>
> It describes **what will be and what is**. The record of **what happened** —
> milestones, the findings log, per-phase artifacts and the completed Phase 0
> runbook — lives in [`history.md`](history.md). Keep the two apart: this file
> should not grow as phases land.

Status: phases 0, 1, 2a, 2b and 2c-1 complete; newest tag `v0.6.0` (repo
registry). Six tools are implemented: the four reads — exercised against the real
GitLab on the success path and on a deliberately broken token — plus `list_repos`
and `sync_repo`. A project registers itself the first time it is used; its policy
(`repos.json`) can include `manual`, which makes no network call that `sync_repo`
did not ask for, while its age always comes from the mirror's sync stamp and
never from the registry. Local-clone resolution (`add_repo`/`remove_repo`) is
next, in 2c-2. The token is supplied by OpenCode's config
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
- Bonus (free with git): repo-wide code search and pickaxe.

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
| **Local clone** | A clone of the project exists at a configured path | Read-only; fetch **only if the ref is missing**; never touch the working tree |
| **Managed mirror** | Project is GitLab-only | Bare mirror under cache dir; fetch per freshness policy |

Local clones are preferred. Mirrors cost disk; local clones cost nothing.

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
      "cloneStrategy": "full",       // "full" | "blobless" (blobless not yet used)
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
write.

### 3.3 Ref resolution flow

```
resolve(project, ref):
  1. Build "git view" (mirror path, or local clone working dir)
  2. If ref resolves locally -> maybe refresh per freshness policy -> return sha
  3. If ref NOT found locally:
       a. fetch once (mirror, or local clone's remote)
       b. retry resolve
       c. if still missing -> clean "ref not found" error listing close matches
```

Step 3 is what makes a brand-new branch appear without a manual sync. Step 3c is
implemented (`src/repoStore.ts`: `rankSimilar`, surfaced by `resolve_ref` and by
`get_file`'s not-found error).

### 3.4 Freshness strategy (core concern)

Mirrors going silently stale is the #1 risk: the agent would confidently cite an
old branch. Mitigations:

1. **Mirror semantics.** `git clone --mirror` sets `remote.origin.mirror=true`,
   so `git fetch` updates all refs **and prunes deleted refs automatically**, and
   honors force-pushes (refspec is forced). Effectively `fetch --prune` for free.
   For non-mirror bare clones we pass `--prune` explicitly.
2. **Per-repo policy** (`freshnessMode`):
   - `ttl` (default): fetch when the last successful sync is older than `ttl`
     (default 600s).
   - `always`: fetch before every read (correct, slower).
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
6. **Concurrency:** serialize fetch per project (a simple in-process lock) so
   parallel tool calls don't run overlapping fetches.
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
> - The fetch decision is re-checked *inside* the per-project lock, so callers
>   queued behind an in-flight fetch do not fetch again.
> - If the TTL step already fetched, a missing ref does not trigger a second
>   fetch; if it did not fetch, the miss triggers exactly one.
> - Policy is resolved in one place — the project's registry entry, else
>   configuration — so the TTL decision, the miss decision and the clone decision
>   cannot disagree with one another.
> - A mirror registers itself the first time it is used, which is why the first
>   `list_repos` on an install that predates the registry lists nothing until a
>   project has been read. Discovery by scanning the cache is deliberately not
>   done: it buys a `registered=false` state and a directory walk to fix a single
>   empty listing.
> - The sync clock lives in a stamp file inside the mirror
>   (`mcp-last-sync`, epoch ms) and is written **only after a fetch succeeds**,
>   so it survives a restart without a failure ever advancing it. `git clone
>   --mirror` writes no `FETCH_HEAD` (verified), so a clone records itself too.
>   git's own `FETCH_HEAD` is deliberately not trusted: git stamps it before a
>   fetch fails, which made a rejected fetch look like a fresh sync. The registry
>   deliberately holds no copy of that clock — two clocks that can disagree is a
>   bug this project has already paid for.
> - A refresh that fails does not fail the read. The cached mirror answers, and
>   the result reports the reason next to `syncedAt`, so staleness stays visible
>   instead of turning into an outage. A ref that does not resolve through a
>   failed refresh says so — otherwise "not found" would read as proof of
>   absence when all it proves is that the mirror is out of date.

### 3.5 Local-clone handling

- Detect the remote dynamically (`git remote -v` / config); do **not** assume
  `origin`.
- Fetch only when the ref is missing; never checkout/stash/switch. There is no
  TTL fetch for a local clone: it is not a mirror of ours to keep fresh, and a
  clone is authoritative about the refs it holds.
- Reading via `git --git-dir=<path>/.git show <ref>:<path>` never changes the
  working tree, so uncommitted work is untouched. A fetch on a miss does write to
  that clone's `.git` (new objects, remote-tracking refs) — accepted deliberately
  (decided 2026-10-18), because the alternative is a tool that cannot see a
  branch you have not fetched yourself.
- If the repo has no reachable remote, degrade gracefully (local refs only).

---

## 4. Tool surface

Tool names are exposed by OpenCode as `gitlab_<tool>`.

**Management**
- `list_repos()` — every registered project, its effective policy, whether its
  data is on disk, and its last successful sync. ✅
- `sync_repo(project)` — fetch now, ignoring the TTL; the only way to refresh a
  `manual` project. ✅ (A `full` re-clone parameter is not implemented; a mirror
  is cloned when it is missing.)
- `add_repo(project, localPath?)` — register; decides mirror vs local. (2c-2)
- `remove_repo(project, deleteMirror?)`. (2c-2)

**Reads (core)**
- `get_file(project, ref, path)` — `git show <ref>:<path>`. ✅
- `list_tree(project, ref, path?, recursive?, max_entries?)` — `git ls-tree -l -z`,
  one level deep by default, paths relative to the repository root. ✅
- `list_refs(project, kind=branches|tags|all, search?, max_refs?)` — `git for-each-ref`,
  scoped to `refs/heads` + `refs/tags`. ✅
- `resolve_ref(project, ref)` — sha existence + close matches. ✅
  (Named `ref` rather than the original `name`, to match `get_file`.)

**Diff & history (selected extras)**
- `compare(project, from, to, path?)` — `git diff`.
- `diff_file(project, path, from, to)`.
- `log(project, ref, path?, limit?)`.
- `get_commit(project, sha)`.
- `blame(project, path, ref, lines?)`.

**Search (free bonus)**
- `search(project, query, ref, glob?)` — `git grep`.
- `pickaxe(project, string, path?)` — `git log -S` ("when was this introduced?").

**Ergonomics**
- `parse_gitlab_url(url)` → `{project, ref, path}` from
  `https://<host>/group/repo/-/blob/<ref>/<path>`.
- Optional configured **default project** so agents can omit it.

Every read result includes: `commit_sha`, `synced_at`, and for text files a
truncation flag when output is capped.

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
| 2c-2 | Local clones: `add_repo`, `remove_repo`, mirror+local resolution | Local clones are preferred; mirrors can still be synced on demand |
| 3 | Diff & history: `compare`, `diff_file`, `log`, `get_commit`, `blame` | "What changed between `develop` and `fix/PROJ-7608`?" works |
| 4 | Polish: `search`, `pickaxe`, URL parser, truncation, caching, stale-visibility | Freshness provenance visible on every read |

> **Status:** phases 0–2c-1 complete; 2b-1 is `v0.3.0`, 2b-2 `v0.4.0`, the
> freshness hardening `v0.5.x`, and 2c-1 is `v0.6.0`. Next is 2c-2 (local
> clones), then 3–4. Per-phase detail: [`history.md`](history.md).

### Source layout

```
src/
  index.ts       # stdio bootstrap
  server.ts      # McpServer + tool registration
  config.ts      # env, host, cache dir, default project, fetch policy
  git.ts         # safe git exec wrapper (array args, no shell)
  gitDiagnostics.ts  # classify git stderr into an actionable hint
  repoStore.ts   # mirror resolution, clone/fetch, ref resolution, freshness
  registry.ts    # repos.json: per-project source and freshness policy
  url.ts         # GitLab web URL -> {project, ref, path}      (Phase 4)
  tools/
    result.ts      # shared tool result shapes and error rendering
    files.ts       # get_file, list_tree                            ✅ Phase 2b-2
    refs.ts        # list_refs, resolve_ref                        ✅ Phase 2b-1
    repos.ts       # list_repos, sync_repo                         ✅ Phase 2c-1
    history.ts  search.ts                                          (later phases)
test/
  fixture.ts     # builds a throwaway "GitLab" (working repo + bare server)
  store.test.ts  # mirror resolution, guards, freshness, project policy
  registry.test.ts  # the registry file: parsing, persistence, corrupt handling
  refs.test.ts   # ref listing, resolution, close matches
  tree.test.ts   # directory listings, the ls-tree parser, rendering
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
| Large repos / disk | Per-repo `blobless` partial clone option; prefer local clones |
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
