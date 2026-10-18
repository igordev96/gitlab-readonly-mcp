# GitLab Read-Only MCP Server (git-backed) — Plan

> **This file is the canonical plan.** It lives in the repository at `docs/plan.md`
> and is version-controlled alongside the code. Edit it here.

Status: **Phase 2a complete** (freshness: TTL, fetch-on-miss, `synced_at`).
Phase 1 verified live. Next: Phase 2b (`list_tree` / `list_refs` / `resolve_ref`).
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
  repos.json                         # registry: project -> source, mode, strategy, last_fetch_at
  mirrors\
    group\subgroup\repo.git          # bare mirror (mirror mode)
```

`repos.json` schema (per project):

```jsonc
{
  "group/subgroup/repo": {
    "source": "mirror",              // "mirror" | "local"
    "localPath": null,               // set when source == "local"
    "cloneStrategy": "full",         // "full" | "blobless"
    "freshnessMode": "ttl",          // "ttl" | "always" | "manual"
    "freshnessTtlSeconds": 600,
    "lastFetchAt": "2026-10-17T12:00:00Z",
    "defaultBranch": "develop"
  }
}
```

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

Step 3 is what makes a brand-new branch appear without a manual sync.

### 3.4 Freshness strategy (core concern)

Mirrors going silently stale is the #1 risk: the agent would confidently cite an
old branch. Mitigations:

1. **Mirror semantics.** `git clone --mirror` sets `remote.origin.mirror=true`,
   so `git fetch` updates all refs **and prunes deleted refs automatically**, and
   honors force-pushes (refspec is forced). Effectively `fetch --prune` for free.
   For non-mirror bare clones we pass `--prune` explicitly.
2. **Per-repo policy** (`freshnessMode`):
   - `ttl` (default): fetch if `now - lastFetchAt > ttl` (default 600s).
   - `always`: fetch before every read (correct, slower).
   - `manual`: never auto-fetch; only via `sync_repo`.
3. **Fetch-on-miss:** an unresolved ref always triggers one fetch + retry.
4. **Visible provenance:** every read result includes the resolved
   `commit_sha` and the source's `synced_at` timestamp, so the response itself
   signals how fresh it is.
5. **Explicit control:** `sync_repo(project)` forces a fetch; `list_repos`
   returns last-fetch times so you can see which are stale.
6. **Concurrency:** serialize fetch per project (a simple in-process lock) so
   parallel tool calls don't run overlapping fetches.

> **Phase 2a status (implemented):** items 1, 3, 4 and 6, plus the `ttl` and
> `always` modes from item 2. `manual` mode and the explicit controls in item 5
> (`sync_repo`, `list_repos`) stay in Phase 2c — shipping `manual` with no way to
> fetch would be a footgun.
>
> Implementation notes:
> - The fetch decision is re-checked *inside* the per-project lock, so callers
>   queued behind an in-flight fetch do not fetch again.
> - If the TTL step already fetched, a missing ref does not trigger a second
>   fetch; if it did not fetch, the miss triggers exactly one.
> - The sync clock is in-memory, falling back to the mirror's `FETCH_HEAD` mtime
>   so it survives a restart. `git clone --mirror` does **not** write
>   `FETCH_HEAD` (verified), so the clone time is recorded explicitly.

### 3.5 Local-clone handling

- Detect the remote dynamically (`git remote -v` / config); do **not** assume
  `origin`.
- Fetch only when the ref is missing; never checkout/stash/switch.
- Reading via `git --git-dir=<path>/.git show <ref>:<path>` never changes the
  working tree, so uncommitted work is untouched.
- If the repo has no reachable remote, degrade gracefully (local refs only).

---

## 4. Tool surface

Tool names are exposed by OpenCode as `gitlab_<tool>`.

**Management**
- `add_repo(project, localPath?)` — register; decides mirror vs local.
- `list_repos()` — projects, mode, cloneStrategy, lastFetchAt.
- `sync_repo(project, full?)` — force fetch (optionally re-clone).
- `remove_repo(project, deleteMirror?)`.

**Reads (core)**
- `get_file(project, ref, path)` — `git show <ref>:<path>`.
- `list_tree(project, ref, path)` — `git ls-tree`.
- `list_refs(project, kind=branches|tags, search?)`.
- `resolve_ref(project, name)` — sha existence + close matches.

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
- **Auth mechanism (verified the hard way — see §11):** `PRIVATE-TOKEN` is a
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
| 0 | Manual plumbing proof (see §9) | `git show fix/PROJ-7608:src/index.tsx` prints the file |
| 1 | MCP skeleton: stdio + `get_file`, wired into OpenCode | Agent reads a file from `fix/PROJ-7608` via MCP |
| 2a | Freshness: TTL + fetch-on-miss, per-project fetch lock, `synced_at` provenance | A branch pushed minutes ago is readable; every read reports how fresh it is |
| 2b | `list_tree`, `list_refs`, `resolve_ref` | Agent can explore a repo it never cloned |
| 2c | Repo registry: `add_repo`/`list_repos`/`sync_repo`, mirror+local resolution, `manual` mode | Local clones are preferred; mirrors can be synced on demand |
| 3 | Diff & history: `compare`, `diff_file`, `log`, `get_commit`, `blame` | "What changed between `develop` and `fix/PROJ-7608`?" works |
| 4 | Polish: `search`, `pickaxe`, URL parser, truncation, caching, stale-visibility | Freshness provenance visible on every read |

> **Status:** Phase 0 ✅ verified. Phase 1 ✅ implemented, locally tested and
> **verified live** — the agent read `src/index.tsx` from `fix/PROJ-7608`
> (commit `8297d0d`) through OpenCode. Tagged `v0.1.0`.
> Phase 2a ✅ implemented and locally tested (21/21, in three files run in
> parallel; freshness covered by real clone/fetch against a fixture server),
> with the suite moved from `scripts/` to `test/`. Tagged `v0.2.0`.
> Phases 2b–4 not started.

### Source layout

```
src/
  index.ts       # stdio bootstrap
  server.ts      # McpServer + tool registration
  config.ts      # env, host, cache dir, default project, fetch policy
  git.ts         # safe git exec wrapper (array args, no shell)
  repoStore.ts   # mirror resolution, clone/fetch, ref resolution, freshness
  url.ts         # GitLab web URL -> {project, ref, path}      (Phase 4)
  tools/
    repos.ts  files.ts  refs.ts  history.ts  search.ts          (growing by phase)
test/
  fixture.ts     # builds a throwaway "GitLab" (working repo + bare server)
  store.test.ts  # mirror resolution, guards, freshness
  protocol.test.ts   # the MCP surface over an in-memory transport
  startup.test.ts    # the compiled entry point over real stdio
tsconfig.json        # typecheck: src/ + test/, noEmit
tsconfig.build.json  # emit: src/ only -> dist/
```

Tests import `src/` directly and run through `tsx` on Node's built-in test
runner, so no build is needed to get feedback and a stale `dist/` can never be
tested by accident. `npm test` builds first so the compiled entry point is still
covered. See §11 for why this shape was chosen.

Stack: TypeScript, `@modelcontextprotocol/sdk`, `zod` for input schemas, Node
child_process `spawn` (array args) for git.

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

## 9. STEP-BY-STEP: what YOU do now, then report back

> **STATUS: COMPLETED ✅ (2026-10-18).** All steps passed: clone, branch
> lookup, file listing, and reading a file from `fix/PROJ-7608`. This section
> is kept as a reproducible reference for onboarding another machine or repo.

Do these in order. Replace `<GITLAB_HOST>` with your server host (no `https://`
in the host placeholder usage below — use the full URL where shown).

### Step 1 — Decide and create the token

Prefer a **Project Access Token** on the pilot repo:
GitLab → that project → **Settings → Access Tokens** → name it
`mcp-readonly`, role **Reporter**, scope **`read_repository`**, set an expiry.

If project tokens are disabled by your admin, use a **personal** access token
(User → Preferences → Access Tokens) with **only** the `read_repository` scope.

> Do NOT use `api` or `write_repository`.

### Step 2 — Set the token in the environment (one shell session)

```powershell
$env:GITLAB_TOKEN = "glpat-XXXXXXXXXXXXXXXXXXXX"
```

### Step 3 — Prove clone works (mirror)

> Note: do **not** name a variable `$HOST` — it is a read-only automatic
> variable in PowerShell (as are `$HOME`, `$PID`, `$PWD`, `$Error`, `$args`).
> Use `$GitLabHost` or similar.

```powershell
$GitLabHost = "https://gitlab.example.com"
$PROJ       = "group/subgroup/repo"
$DST        = "$env:TEMP\repro.git"
Remove-Item -Recurse -Force $DST -ErrorAction SilentlyContinue
$env:GIT_TERMINAL_PROMPT = "0"

# verify the token is actually set in THIS shell
if ([string]::IsNullOrWhiteSpace($env:GITLAB_TOKEN)) { "TOKEN EMPTY!" }
else { "token set, length " + $env:GITLAB_TOKEN.Length }

# correct auth: Basic, NOT PRIVATE-TOKEN
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("oauth2:$env:GITLAB_TOKEN"))

git -c credential.helper= `
    -c http.extraheader="Authorization: Basic $b64" `
    clone --mirror "$GitLabHost/$PROJ.git" "$DST"
```

> Do **not** use `http.extraheader="PRIVATE-TOKEN: ..."` — that is a REST API
> header and git-over-HTTPS ignores it, producing
> `remote: HTTP Basic: Access denied` followed by a username/password prompt.

- Success → continue.
- **Certificate error** → internal CA. Try:
  `git -c http.sslCAInfo="C:\path\to\ca.pem" ...` and report.
- **401/403** → check the token is set (length check above), not expired, and has
  `read_repository`; report the exact message.
- Quick-and-dirty alternative that definitely works (throwaway only — leaks the
  token into `.git/config` and history):
  `git clone --mirror "https://oauth2:$env:GITLAB_TOKEN@<host>/<proj>.git" $DST`

### Step 4 — Prove ref + file read

```powershell
# 1. confirm the branch is present
git --git-dir="$DST" for-each-ref --format="%(refname:short)" refs/heads | Select-String "fix/PROJ-7608"

# 2. list a few files on that branch so you can pick a real path
git --git-dir="$DST" ls-tree -r --name-only "fix/PROJ-7608" | Select-Object -First 40

# 3. read a real file from that branch (replace the path)
git --git-dir="$DST" show "fix/PROJ-7608:src/index.tsx"
```

Notes:
- Branch names containing `/` are fine for `git show <ref>:<path>` as long as the
  ref is unambiguous (no branch+tag collision).
- Replace `src/index.tsx` with a path that actually exists in step 2's listing.

### Step 5 — Measure size (drives clone strategy)

```powershell
git --git-dir="$DST" count-objects -vH
```

### Step 6 — Confirm environment

```powershell
node --version        # expect v24.x
npm --version         # expect 11.x
Test-Path $env:LOCALAPPDATA   # cache dir writable?
```

### Step 7 — Clean up the test clone (optional, frees disk)

```powershell
Remove-Item -Recurse -Force $DST
Remove-Item Env:\GITLAB_TOKEN
```

### Report back with this template

```
1. GITLAB_HOST (base URL):
2. Pilot project path (group/subgroup/repo):
3. Pilot branch that is NOT the default (e.g. fix/PROJ-7608):
4. A real file path on that branch (e.g. src/index.tsx):
5. Token type: project-access-token | personal-pat
6. Token scope used:
7. Step 3 result: OK | cert-error | auth-error  (paste message if error)
8. Step 4 result: branch found? file printed? (paste a line or two)
9. Step 5 size (count-objects -vH):
10. Node/npm versions + LOCALAPPDATA writable:
11. Which auth method worked: Basic-header | Bearer-header | URL-embedded | none
12. Anything else (VPN, proxy, unusual auth):
```

### What I will do once you report

- If **cert-error**: add CA handling to `config.ts`/`git.ts` (Phase 0 fix first).
- If **all OK**: scaffold Phase 1 (stdio MCP + `get_file`), wire it into OpenCode,
  and have you verify the agent reads `src/index.tsx` from `fix/PROJ-7608` in-session.
- Then proceed Phase 2 → 4 per §7.

> To start implementation, switch me out of Plan mode to a build agent (e.g.
> `build`). Nothing gets scaffolded until then.

---

## 10. Out of scope (for now)

- Write operations (create/edit files, comment on MRs) — would need `api` scope.
- Merge request review and CI/pipeline logs — REST API features; revisit later
  behind the same server as an optional second backend.
- Shared/multi-user hosting — would require HTTP transport and real auth.
- Other git hosts (GitHub/Bitbucket) — git layer is host-agnostic, but nothing
  GitLab-specific beyond the URL parser.

---

## 11. Findings log

Running record of things learned during Phase 0. Keep appending.

| Date | Finding | Resolution |
|---|---|---|
| 2026-10-18 | `$HOST` is a read-only PowerShell automatic variable; assignment fails. | Use `$GitLabHost`. Avoid `$Host`, `$HOME`, `$PID`, `$PWD`, `$Error`, `$args`. |
| 2026-10-18 | `http.extraheader="PRIVATE-TOKEN: <token>"` → `remote: HTTP Basic: Access denied`, then username/password prompt. | `PRIVATE-TOKEN` is API-only; git-over-HTTPS ignores it. Use `Authorization: Basic <base64(oauth2:token)>` (or Bearer). |
| 2026-10-18 | Host confirmed: `https://gitlab.example.com`. Pilot project: `group/subgroup/repo`. | Pending Phase 0 re-run. |
| 2026-10-18 | `test-000` was a placeholder; the real non-default branch is `fix/PROJ-7608`. | Plan updated throughout; pilot branch set to `fix/PROJ-7608`. |
| 2026-10-18 | **Phase 0 PASSED.** Mirror clone succeeded; `fix/PROJ-7608` present; `ls-tree` listed files; `git show "fix/PROJ-7608:<path>"` printed file contents. | Premise validated. Ready for Phase 1. |
| 2026-10-18 | No TLS/certificate error → GitLab does **not** use an internal CA. | CA handling not required (keep as optional config). |
| 2026-10-18 | Confirmed working auth: `-c credential.helper= -c http.extraheader="Authorization: Basic <base64(oauth2:token)>"`. | Use this in `git.ts` for all clone/fetch calls. |
| 2026-10-18 | Repo size under ~200 MB. | Default `cloneStrategy: "full"` is appropriate; blobless deferred. |
| 2026-10-18 | Token is a **personal PAT** with clone/fetch access (scope not separately verified). | Verify scope is `read_repository`; prefer a Project Access Token later. |
| 2026-10-18 | `example-app` is **not** cloned locally. | MCP uses its own managed mirror for this project; "prefer local" still applies to other repos. |
| 2026-10-18 | **Phase 1 implemented.** Project built at `C:\Users\example\Documents\projects\mcp-test` (TS + `@modelcontextprotocol/sdk` 1.32.1). Exposes `get_file`. | Wired into OpenCode globally as `gitlab` (`C:\Users\example\.config\opencode\opencode.jsonc`). |
| 2026-10-18 | Local validation: 14/14 smoke tests pass (store layer + MCP protocol over in-memory transport), incl. injection guard, missing ref/path, truncation, binary guard. `scripts/smoke.mjs`. | No network/token needed; run with `npm run smoke`. |
| 2026-10-18 | `opencode mcp list` → `✗ gitlab failed: Connection closed ... GITLAB_TOKEN is required`. | Expected: env var not persisted. User must set a User-level `GITLAB_TOKEN` and restart the service. |
| 2026-10-18 | Token was only set in the earlier shell session, never persisted. | Persist via `[Environment]::SetEnvironmentVariable('GITLAB_TOKEN','<token>','User')` then `opencode service restart`. |
| 2026-10-18 | **Phase 1 verified live.** `gitlab.get_file` returned the real contents of `src/index.tsx` from `fix/PROJ-7608` (resolved commit `8297d0d`) through OpenCode. | Phase 1 exit criterion met; tagged `v0.1.0`. |
| 2026-10-18 | `{env:NAME}` is a *literal* lookup, not a fallback. A token pasted inside it (`"{env:glpat-…}"`) makes OpenCode look for an env var literally *named* `glpat-…`, so nothing resolves and the server exits with `GITLAB_TOKEN is required`. | Never put a secret value inside `{env:...}`. Also watch for a duplicate `GITLAB_TOKEN` key in the config. |
| 2026-10-18 | The PAT was briefly exposed in cleartext (global config, Windows registry, session transcript). | **Rotated.** Config reads `{env:GITLAB_TOKEN}`; prefer a Project Access Token with an expiry for ongoing use. |
| 2026-10-18 | Plan moved into the repository and made canonical at `docs/plan.md`. | Future plan edits happen in-repo; the out-of-tree copy becomes a pointer stub. |
| 2026-10-18 | `git clone --mirror` does **not** create `FETCH_HEAD`; it appears only after a `fetch`. | Can't use `FETCH_HEAD` mtime alone as the sync clock. Seed an in-memory timestamp at clone time, then prefer the newest of memory and `FETCH_HEAD` mtime (survives restarts). |
| 2026-10-18 | `git fetch --prune --tags` inside a mirror picks up new branches and prunes deleted ones (verified against a local fixture remote). | Mirror fetch is the freshness primitive; the mirror refspec already forces updates. |
| 2026-10-18 | `git push --all --tags` is rejected: "options '--tags' and '--all/--branches' cannot be used together". | The smoke fixture publishes with two separate pushes. |
| 2026-10-18 | First freshness test failed misleadingly: the fixture had the client clone from an *intermediate mirror* that the mutation helpers never updated, so the client's `fetch` correctly found nothing new. The server was fine; the test double was wrong. | Fixture rebuilt as `work` (a checkout) → `demo.git` (a bare "server"), with mutations published by `push`. The client clones `demo.git`, mirroring how GitLab is addressed. |
| 2026-10-18 | `npm run smoke` (later `npm test`) imported the *compiled* `dist/`, so running it after only `npm run typecheck` tested stale code — and it did, once, during Phase 2a. | Tests now import `src/` directly via `tsx`; `npm test` builds first only so the compiled-entry-point test still covers `dist/`. |
| 2026-10-18 | The test suite lived in `scripts/` while containing no scripting at all — it was a `test/` folder wearing a tooling name, which made the project awkward to navigate. | Moved to `test/`; `scripts/` deleted. |
| 2026-10-18 | `node --test <directory>` does not discover `.ts` files, and a glob passed to a shell is not expanded by `cmd` on Windows. | Pass a *quoted* glob: `node --import tsx --test "test/**/*.test.ts"`. Node expands it itself (verified on Node 24.21). |
| 2026-10-18 | A single `tsconfig.json` with `rootDir: "src"` cannot also typecheck `test/`. | Split: `tsconfig.json` is a no-emit config covering `src/` + `test/`; `tsconfig.build.json` extends it with `rootDir: "src"` and emits to `dist/`. `npm run typecheck` now covers the tests. |
| 2026-10-18 | Node's test runner executes one child process per test file, in parallel. | Each test file builds its own fixture under a distinct temp directory, so files never collide. |
| 2026-10-18 | **Phase 2a complete.** TTL + fetch-on-miss freshness implemented and locally tested; the suite moved out of `scripts/` into `test/`. | Exit criterion met: a branch pushed minutes ago is readable and every read reports `synced_at`. Tagged `v0.2.0` on `1281009`. |

### Phase 2a artifacts

- `src/config.ts` — added `GITLAB_FETCH_MODE` (`ttl` \| `always`) and
  `GITLAB_FETCH_TTL_SECONDS` (default 600), both validated.
- `src/repoStore.ts` — `refresh()` (TTL/always), fetch-on-miss, a per-project
  serialisation lock (`enqueue`), `lastSyncAt()`, and `fetched`/`syncedAt` on
  results.
- `src/tools/files.ts` — `synced_at` added to the provenance wrapper.
- `test/fixture.ts` — reproducible fixture (working repo + bare server), each
  test file getting its own root.

### Project structure (Phase 2a)

- `test/` replaces `scripts/` — `fixture.ts` plus `store.test.ts`,
  `protocol.test.ts`, `startup.test.ts`.
- `tsconfig.json` (typecheck `src/` + `test/`, no emit) and
  `tsconfig.build.json` (emit `src/` → `dist/`).
- `package.json` — `npm test` replaces `npm run smoke`; `build` points at
  `tsconfig.build.json`.
- `AGENTS.md` — pre-commit sequence is now `npm run typecheck && npm test`.

### Phase 1 artifacts

- `src/config.ts` — env parsing/validation (`GITLAB_HOST`, `GITLAB_TOKEN`, `GITLAB_DEFAULT_PROJECT`, `GITLAB_MCP_CACHE`, `GITLAB_CA_INFO`).
- `src/git.ts` — safe git wrapper (array args, `shell:false`, `http.extraheader` auth, `credential.helper=`, `GIT_TERMINAL_PROMPT=0`, output caps).
- `src/repoStore.ts` — mirror path, clone-on-first-use, `syncMirror`, `resolveRef`, `readFile`, path/ref injection guards, token redaction.
- `src/tools/files.ts` — the `get_file` tool.
- `src/server.ts`, `src/index.ts` — server composition and stdio bootstrap.
- `scripts/smoke.mjs`, `scripts/stdio-check.mjs` — offline tests. *(Moved to
  `test/` in Phase 2a; see "Project structure" below.)*
- `README.md` — setup, config, security, roadmap.
