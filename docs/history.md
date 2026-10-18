# History: milestones, findings and phase artifacts

> **This file accumulates what happened.** The forward-looking design lives in
> [`plan.md`](plan.md); this file is the record — what shipped, what we learned,
> and what each phase actually touched. Unlike the plan, it is *meant* to grow.
> Keep appending.

---

## Milestones

Each tag records the state of the repository at that point. A commit cannot
reference its own tag, so each milestone is recorded here by a follow-up commit.

| Tag | Commit | What shipped | Verified live |
|---|---|---|---|
| `v0.1.0` | `99f40af` | Phase 1 — stdio MCP exposing `get_file`, wired into OpenCode as `gitlab`. | ✅ Read `src/index.tsx` from `fix/PROJ-7608` (commit `8297d0d`) through OpenCode. |
| `v0.2.0` | `1281009` | Phase 2a — TTL + fetch-on-miss freshness, per-project fetch lock, `synced_at` provenance; the suite moved from `scripts/` to `test/`. | ✅ After the token/restart fix. |
| `v0.2.1` | `f91fd4f` | Failure diagnostics — git's own stderr surfaced and classified into credentials / project path / private CA / network. | ✅ A read that had previously failed returned both `commit` and `synced_at`. |
| `v0.3.0` | `b779788` | Phase 2b-1 — `list_refs`, `resolve_ref`, close-match hints. Also carries the version sourced from `package.json`. | ✅ `resolve_ref` and `list_refs` both returned real refs from the pilot project. A `list_refs` TTL refresh was rejected by GitLab as credentials — see findings. |
| `v0.4.0` | `50f697e` | Phase 2b-2 — `list_tree`: browse a directory at any ref, one level deep or recursive, with blob sizes, a cap and provenance. | ✅ Verified live against `example-app`: `src` listing with sizes, recursive capped at 200 of 1710, and listing a file pointed at `get_file`. |
| `v0.5.0` | `cdd9a2c` | Freshness hardening from the `v0.4.0` live check — the sync clock is a stamp written only on success, and a refresh that fails answers from the cache and reports why. | ⏳ Not yet exercised through OpenCode on this build. |

Phase 0 predates the first tag: it was verified by hand — mirror clone succeeded,
`fix/PROJ-7608` was present, `ls-tree` listed files, and
`git show "fix/PROJ-7608:<path>"` printed the file. See the runbook below.

---

## Findings log

Running record of things learned while building. Keep appending.

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
| 2026-10-19 | A live read failed with only *"Failed to clone \<project\> from \<host\>"*. The tool forwarded `error.message` and dropped the `GitError.stderr` field, so a rejected token was indistinguishable from a VPN outage; diagnosing it took manual probing. | `GitError.stderr` is now surfaced as a `git said: …` excerpt and classified by `src/gitDiagnostics.ts` into credentials / project path / private CA / network. Token redaction moved into `Git.redact` so every consumer gets it. Tested against real git stderr samples. |
| 2026-10-19 | The real cause: the token in the environment was valid, but the MCP child process had been started before it was set, so the server authenticated with the previous (revoked) value. | Documented in README under Troubleshooting: a running server keeps the token it started with, so restart the client after changing it. The credential hint now says this in the failure message itself. |
| 2026-10-19 | **Phase 2a verified live.** After the token fix, a read of `src/index.tsx` on `fix/PROJ-7608` through OpenCode returned both `commit` and `synced_at`. | Freshness is confirmed end to end, not just against the fixture. Tagged `v0.2.1` on `f91fd4f` together with the failure diagnostics. |
| 2026-10-18 | **Phase 2a complete.** TTL + fetch-on-miss freshness implemented and locally tested; the suite moved out of `scripts/` into `test/`. | Exit criterion met: a branch pushed minutes ago is readable and every read reports `synced_at`. Tagged `v0.2.0` on `1281009`. |
| 2026-10-18 | GitLab advertises `refs/merge-requests/*` (one per MR), and `git clone --mirror` copies **every** ref the server offers. An unfiltered "all refs" listing would therefore be dominated by merge requests. | `list_refs` is scoped to `refs/heads` + `refs/tags`. The fixture carries an MR ref so this stays a tested guarantee, not an assumption. |
| 2026-10-18 | A first run of the new tests reported `default_branch="master"` for a repository whose only branch is `main`. The fixture's bare "server" was created with `git init --bare` and no `-b`, so its HEAD named a branch that never existed. | Fixture initialises the server with `-b main`. Worth noting because the mirror's HEAD is copied from the remote's HEAD — a real GitLab repo has this right, a hand-made bare repo may not. |
| 2026-10-18 | `%(committerdate:iso-strict)` on an annotated tag reflects the tag object, not the commit it points at; only `%(*committerdate:iso-strict)` is dereferenced. | Read both fields and prefer the dereferenced one, matching how `%(objectname)`/`%(*objectname)` are used to peel tags to their commit. |
| 2026-10-18 | A tool-callback result typed as an **interface** failed to compile against the SDK (`Index signature for type 'string' is missing`), while the identical shape as a **type alias** compiled. | Only object-literal-typed aliases get an implicit index signature; interfaces do not. `ToolTextResult` in `src/tools/result.ts` is a type alias for this reason. |
| 2026-10-18 | `SERVER_VERSION` was a hand-maintained literal in `src/server.ts` and had silently drifted: the server reported `0.1.0` while the newest tag was `v0.2.1`. | Version is now read from `package.json`, whose bump and the tag are the same step (`npm version`), so drift is impossible. `test/startup.test.ts` asserts the compiled server reports exactly `package.json`'s version. |
| 2026-10-18 | **Phase 2b-1 complete and tagged `v0.3.0`.** `list_refs`, `resolve_ref` and the close-match hints implemented; suite grew from 38 tests / 8 suites to 60 / 11. | Exit criterion met: an agent can find a branch, confirm its commit, and read a file, all without cloning. Tag is annotated and points at the release commit, whose `package.json` says `0.3.0`. |
| 2026-10-18 | The plan had become 39% history: 132 lines of completed Phase 0 runbook plus 110 lines of findings and per-phase artifacts, growing with every phase, so that a reader looking for the tool surface had to scroll past a pile of dated entries. | Split by tense: `plan.md` describes what will be and what is; `history.md` (this file) accumulates what happened. Recorded as a convention in `AGENTS.md`, because otherwise the two quietly re-converge. |
| 2026-10-18 | `git ls-tree <commit>:<dir>` reports paths **relative to `<dir>`** — listing `src` yields `index.tsx`, not `src/index.tsx`. A test asserting full paths failed and caught it; the manual probe that "confirmed" the format had been read carelessly. | `listTree` re-roots every entry through the listed directory, so paths compose directly with `get_file`'s `path`. A trailing slash is stripped first, or the prefix would double it up. |
| 2026-10-18 | `ls-tree` exits 128 for both a missing path (`fatal: Not a valid object name`) and a file where a directory was expected (`fatal: not a tree object`). | `treeFailure` turns them into distinct not-found messages, and the second points at `get_file` — git's own wording never says which tool the caller actually wanted. |
| 2026-10-18 | `ls-tree -l` right-aligns the size column with leading spaces and prints `-` for a tree, so splitting the header on a single space yields empty fields; and splitting the listing on newlines would let a path containing a newline forge a second entry. | The listing is read with `-z` and parsed as NUL-terminated records, header split with `trim().split(/\s+/)`. Both verified against real output rather than assumed, and both covered by parser tests. |
| 2026-10-18 | **Phase 2b-2 complete and tagged `v0.4.0`.** `list_tree` implemented; suite grew from 60 tests / 11 suites to 79 / 14. | Exit criterion met: an agent can browse a tree it never cloned. The tag is annotated and points at the release commit, whose `package.json` says `0.4.0`. |
| 2026-10-18 | **A rejected fetch still advances the sync clock, so the server reports freshness it never achieved.** `lastSyncAt` takes the newest of the in-memory time and the mirror's `FETCH_HEAD` mtime, but git truncates `FETCH_HEAD` to 0 bytes and stamps it *before* the fetch fails. Seen live: `list_refs` fetched, GitLab rejected the credentials, and every call afterwards reported `synced_at="2026-10-18T16:43:19.233Z"` — the moment of that failure. | Reproduced by hand against the mirror with the same fetch the server runs: `FETCH_HEAD` went from 0 bytes at 17:43:19 to 0 bytes at 17:46:15, exit 128. **Fixed** — the clock now reads a stamp written only on success. |
| 2026-10-18 | The live check's fetch was rejected as credentials, although a fetch from the same machine had succeeded about eleven minutes earlier: `git said: fatal: could not read Username for 'https://gitlab.example.com': terminal prompts disabled`. Git was asked to authenticate and prompts are disabled, so the fetch fails fast rather than hanging. | **Open, and this one needs the token owner.** The assistant cannot see `GITLAB_TOKEN`. Check its expiry, scope and project access — and confirm the restarted server sees the value you intend, since a restarted MCP child inherits the environment OpenCode itself was started with. |
| 2026-10-18 | The pilot repo has **1710 files** on `fix/PROJ-7608`, so a recursive `list_tree` hits the default 200-entry cap immediately: `[truncated: showing 200 of 1710 entries]`. | Working as designed, and the truncation marker earned its keep on its first real use. Worth remembering that browsing a real repo recursively needs `max_entries`. |
| 2026-10-18 | A read whose refresh failed failed outright, even with a usable mirror sitting in the cache: the fetch threw before the read could answer. Live, that was the whole difference between `list_refs` failing and `resolve_ref` succeeding on the same repo at the same moment. | A failed refresh is now reported instead of thrown: the cached mirror answers and the result carries `refreshFailed`, printed as `refresh_failed="true"` plus a `[refresh failed: …]` note beside the `synced_at` of the last real sync. A ref that does not resolve through a failed refresh says so too, because otherwise "not found" reads as proof of absence. `resolveRefInfo` now throws `NotFoundError` like every other read, so one place builds that message. Suite: 82 tests / 14 suites → 92 / 16. |
| 2026-10-18 | The fix for the failed-fetch clock: the sync time moved out of git's `FETCH_HEAD` into a `mcp-last-sync` stamp inside the mirror, written only after a fetch returns success — and at clone time, since a clone writes no `FETCH_HEAD`. | Suite grew from 79 tests / 14 suites to 82 / 14: the stamp survives a restart, a failed fetch leaves it alone, and a freshly stamped `FETCH_HEAD` is ignored. Chosen over a one-line empty-file guard, which would infer success from an implementation detail of git rather than a record of one. |

---

## Per-phase artifacts

What each phase actually touched. The plan keeps only the design; this is the
blow-by-blow.

### Phase 2b-2 artifacts

- `src/repoStore.ts` — `listTree` (`ls-tree -l -z`, one level deep by default,
  `-r` when recursive), the exported `parseTreeEntries` parser, and
  `treeFailure`, which maps git's two failure modes onto not-found errors. Paths
  are re-rooted to the repository root; `TreeEntry`/`TreeListResult` describe the
  shape.
- `src/tools/files.ts` — the `list_tree` tool, alongside `get_file`, with an
  exported `formatTree` so the rendering is testable on its own.
- `src/server.ts` — the server instructions now name `list_tree` in the read
  path (`list_refs` → `resolve_ref` → `list_tree` → `get_file`).
- `test/tree.test.ts` — new: store-level listings, the parser and the renderer.
  `test/protocol.test.ts` extended with the tool as a client sees it.
- No new config, no new environment variable, no new dependency. Suite: 79 tests
  / 14 suites (was 60 / 11).

### Phase 2b-1 artifacts

- `src/repoStore.ts` — `listRefs`, `resolveRefInfo`, `suggestRefs`, and the
  internals behind them (`rawRefs` reading a NUL-separated `for-each-ref`
  format, `defaultBranch`, `namedRef`); exported `rankSimilar`, `editDistance`
  and `formatRefNotFound`. `readFile`'s missing-ref error now carries close
  matches. New caps: `DEFAULT_MAX_ENTRIES` (200), `HARD_MAX_ENTRIES` (5000).
- `src/tools/refs.ts` — new: `list_refs` and `resolve_ref`, with `formatRefList`
  / `formatResolvedRef` kept as plain functions so the rendering is testable.
- `src/tools/result.ts` — new: shared `textResult` / `errorResult` /
  `failureMessage` and the single "no project" message, now used by both tool
  modules.
- `src/server.ts` — registers the ref tools; instructions now point at
  `list_refs` → `resolve_ref` → `get_file`.
- `test/fixture.ts` — adds annotated tag `v1.0`, a nested directory, a
  `refs/merge-requests/1/head` ref, and `-b main` on the bare server.
- `test/refs.test.ts` — new; `test/protocol.test.ts` extended. Suite: 60 tests /
  11 suites (was 38 / 8).

Versioning: the reported server version is read from `package.json` instead of a
literal, so it cannot drift from the newest tag (see `plan.md`, "Versioning").

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

### Failure diagnostics (Phase 2a follow-up)

- `src/gitDiagnostics.ts` — new: `hintForGitStderr` classifies credentials /
  project path / private CA / network, and `explainGitError` composes the cause,
  the hint and a truncated stderr excerpt.
- `src/git.ts` — `Git.redact` is now the single place the token is stripped from
  output.
- `src/tools/files.ts` — a `GitError` is reported through `explainGitError`
  rather than as a bare message.
- `test/git.test.ts`, `test/gitDiagnostics.test.ts` — new units, driven by real
  git stderr samples; `store.test.ts` and `protocol.test.ts` assert that the
  evidence survives as far as the agent.

### Phase 1 artifacts

- `src/config.ts` — env parsing/validation (`GITLAB_HOST`, `GITLAB_TOKEN`, `GITLAB_DEFAULT_PROJECT`, `GITLAB_MCP_CACHE`, `GITLAB_CA_INFO`).
- `src/git.ts` — safe git wrapper (array args, `shell:false`, `http.extraheader` auth, `credential.helper=`, `GIT_TERMINAL_PROMPT=0`, output caps).
- `src/repoStore.ts` — mirror path, clone-on-first-use, `syncMirror`, `resolveRef`, `readFile`, path/ref injection guards, token redaction.
- `src/tools/files.ts` — the `get_file` tool.
- `src/server.ts`, `src/index.ts` — server composition and stdio bootstrap.
- `scripts/smoke.mjs`, `scripts/stdio-check.mjs` — offline tests. *(Moved to
  `test/` in Phase 2a; see "Project structure" above.)*
- `README.md` — setup, config, security, roadmap.

---

## Phase 0 runbook (completed)

> **STATUS: COMPLETED ✅ (2026-10-18).** All steps passed: clone, branch
> lookup, file listing, and reading a file from `fix/PROJ-7608`. Kept as a
> reproducible reference for onboarding another machine or repo — which is why it
> lives here rather than in the plan.

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
- Then proceed Phase 2 → 4 per the plan's phase table.

> To start implementation, switch me out of Plan mode to a build agent (e.g.
> `build`). Nothing gets scaffolded until then.
