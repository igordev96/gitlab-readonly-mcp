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
| `v0.1.0` | `55ef7e8` | Phase 1 — stdio MCP exposing `get_file`, wired into OpenCode as `gitlab`. | ✅ Read `src/index.tsx` from `fix/PROJ-7608` (commit `8297d0d`) through OpenCode. |
| `v0.2.0` | `8fdb109` | Phase 2a — TTL + fetch-on-miss freshness, per-project fetch lock, `synced_at` provenance; the suite moved from `scripts/` to `test/`. | ✅ After the token/restart fix. |
| `v0.2.1` | `c3c8b57` | Failure diagnostics — git's own stderr surfaced and classified into credentials / project path / private CA / network. | ✅ A read that had previously failed returned both `commit` and `synced_at`. |
| `v0.3.0` | `4d62ef6` | Phase 2b-1 — `list_refs`, `resolve_ref`, close-match hints. Also carries the version sourced from `package.json`. | ✅ `resolve_ref` and `list_refs` both returned real refs from the pilot project. A `list_refs` TTL refresh was rejected by GitLab as credentials — see findings. |
| `v0.4.0` | `065d808` | Phase 2b-2 — `list_tree`: browse a directory at any ref, one level deep or recursive, with blob sizes, a cap and provenance. | ✅ Verified live against `example-app`: `src` listing with sizes, recursive capped at 200 of 1710, and listing a file pointed at `get_file`. |
| `v0.5.0` | `b0302e9` | Freshness hardening from the `v0.4.0` live check — the sync clock is a stamp written only on success, and a refresh that fails answers from the cache and reports why. | ✅ The degraded path, live: with the token still rejected, all four tools answered from the cache with `refresh_failed="true"` instead of failing (`list_refs` 74 refs, `list_refs` search 8, `list_tree` 23 entries, `get_file` at the same `8297d0d` Phase 1 read). No `synced_at` advanced. The success path — a fetch that writes the stamp — was unverified at that point; the later `v0.5.1` runs proved it. The check found two defects, both in the findings log. |
| `v0.5.1` | `c353524` | Both defects from the `v0.5.0` check: the refresh note now carries the diagnostic, and an unmeasured sync time reads `synced_at="unknown"` instead of vanishing. | ✅ The failure note is verified live; the `unknown` rendering is still tests-only. Two runs. **Working token:** the first read fetched (2099 ms) and reported a real `synced_at`, later reads inside the TTL were 74–81 ms reporting the same value, and the mirror gained a 14-byte `mcp-last-sync`. **Token deliberately broken:** all four tools answered from cache in ~500 ms with `refresh_failed="true"`, the credentials hint and `git said: … could not read Username …`, counts and commit unchanged, and `synced_at` stayed at the stored `17:48:48.101Z` while git's own `FETCH_HEAD` was zeroed and restamped at `19:03:55` — the old build would have reported that failure time as the sync time. `synced_at="unknown"` needs a mirror with no stamp; that machine has none, so it stays unit-tested only. |
| `v0.6.0` | `5717941` | Phase 2c-1 — the project registry (`repos.json`), a per-project freshness policy including `manual`, and the `list_repos` / `sync_repo` tools. The registry holds policy only: a project's age still comes from the mirror's stamp. | ✅ All four calls matched their predicted shapes against the pilot project. `list_repos` before any read: `count="0"` in 9 ms — "registered on first use", made visible rather than assumed. `get_file` on `fix/PROJ-7608` fetched in 2653 ms, `commit="8297d0da…"`, `synced_at="2026-10-18T20:52:24.529Z"`. `list_repos` then: `count="1"`, `source=mirror freshness=ttl ttl=600s present=true`, carrying *that* stamp. `sync_repo` took 887 ms and reported `20:52:25.491Z`; a final `list_repos` reported that newer value although `repos.json` on disk holds no time at all — the one-clock claim shown, not argued. `manual` mode and local clones were not exercised live (tests only). |
| `v0.7.0` | `1dde469` | Phase 2c-2 — `add_repo` / `remove_repo`, and reading a project from a clone of your own: source resolution moved into a new `src/sources.ts`, the remote-tracking ref view a clone needs, a per-source fetch lock and clock, and a delete guard that never touches a clone. | ✅ The whole cycle against the pilot, driven through OpenCode. `remove_repo` → `list_repos` `count="0"` → `get_file` re-registered the **mirror** and answered `8297d0da…` at its `21:44:25.655Z`. `add_repo(local_path=…)` → `updated="true"`, "nothing was fetched"; `list_repos` `source=local … present=true … synced_at="unknown"`; `get_file` then answered from `refs/remotes/origin/fix/PROJ-7608` with `synced_at="unknown"` — no fetch, no mirror. `resolve_ref` named `refs/remotes/origin/…`. Deleting that ref took `list_refs` to `count="0"`, and the next `get_file` fetched it back from the clone's own remote (`21:45:08.982Z`), after which `list_refs` showed it again. `sync_repo` advanced the clone to `21:45:28.856Z` while the **mirror's** stamp stayed at `21:44:25.655Z`, with still exactly one mirror in the cache. `remove_repo(delete_mirror=true)` left the clone on disk and said so; the next read went back to the mirror. `git status --porcelain` in the clone was 0 bytes before and after every call, an untracked file left in place. Tests-only: a bare-repo registration, a clone with no remote, `always`/`manual` with a local source, and a vanished path. |
| `v0.8.0` | `6f51d1e` | Phase 4a — `search` (`git grep` over the tree of any ref, grouped by file, capped) and `pickaxe` (`git log -S`: the commits that changed how often a text appears). A new `src/tools/search.ts`; `repoStore` gained both, the two parsers and a `HEAD` default. Written plan-first: §4 was drafted and reviewed before any code. | ✅ Twelve calls through OpenCode against the pilot, and the restart itself: the live catalog went from 8 tools to 10 with `gitlab_search` / `gitlab_pickaxe` present. `search "orderTotals"` on `fix/PROJ-7608` → `count="13" files="6"` in 104 ms. The token the branch added, `exampleToken`: **3 matches in 1 file on the branch, `count="0"` on `develop`** — the ref claim demonstrated rather than asserted. `data-testid` capped at 5 → `count="5" total="682" files="269"`. No ref given → `ref="develop"`, the mirror's HEAD, named. `ORDERTOTALS` → 13 by default, `0` with `case_sensitive="true"`. Literal `orderTotals\|exampleToken` → `0`; `regex="true"` → `16` in 7 files. `:(glob)src/**/*.tsx` → 12 of 13. `pickaxe "exampleToken"` → exactly one commit, `8297d0da2`, 2026-10-15, Author — the branch's own fix, which is the "when did it appear" answer. `pickaxe "orderTotals" limit=5` → 5 rows, `truncated="true"`, and `count="0"` with `case_sensitive="true"`. Nothing matched → `(no matches)`, not an error. A wrong ref → the not-found message with five suggestions. Costs: grep ~100 ms, pickaxe 1.2–1.6 s, a read that fetched 2.4 s, a miss that fetched 1.9–2.1 s. **Two defects found here**, both now fixed and re-verified: `-S`'s case-sensitivity, and a file count that described the returned slice. Tests-only: byte-cap truncation, `max_matches` above the hard cap, a CRLF line, a path containing a newline, and both tools against a registered clone. |
| `v0.9.0` | `54ff36e` | Phase 4b — GitLab URLs (`parse_gitlab_url`, `url` on `get_file`/`list_tree`, `#L12-20` ranges), `search` output modes (`matches` / `files` / `count`) and match context assembled from blob reads, refusal by name of a `cloneStrategy` the server cannot honour, and the truncation and stale-visibility review. Eleven tools. | ✅ Through OpenCode after `opencode service restart` (the catalog was empty for a moment, then showed 11 tools): `parse_gitlab_url` on a slashed-ref blob link to `Report.tsx` with `#L118-126` → `ref_kind="branch" ref_confirmed="true"`, `lines="118-126"`; `get_file` by that URL → `file_lines="373"`, exactly lines 118–126; `search "data-testid" output="count"` → `count="100" total="682" files="269"`; `search context=2` → `>`-marked hunks with `…` between them; `list_tree` by a tree URL listed the directory. Five failure shapes behaved as specified: a foreign host refused with both names, `context` paired with `output:"files"` refused, a deliberately wrong ref that fetched once and returned five real branch suggestions, an MR link refused by name, and a URL whose project disagreed with `project=` refused before the mirror was touched. Four concurrent first reads shared one fetch (one `synced_at`). Tests-only: the blobless refusal (needs a hand-edited `repos.json`), a clone with no remote, a vanished path, CRLF, a path containing a newline, bare-repo registration, and `search`/`pickaxe` against a registered clone. |
| `v0.10.0` | `00f930b` | Phase 3 — diffs and history: `log` and `get_commit` (3a), `blame` (3b), `compare` and `diff_file` (3c), and 3d's links: `/-/commit/<sha>` to `get_commit`, `/-/commits/<ref>[/<path>]` to `log`, and a blob, raw or blame link to `blame` — each link kind with one reader that refuses the others by name. Sixteen tools; `rev` on `get_commit` and `path` on `blame` became optional because a link can supply them. | ✅ Through OpenCode after `opencode service restart` — the assistant's own tool list went from 11 gitlab tools to 16, which is the probe that the restart landed. Wired-up, against `example-app` @ `fix/PROJ-7608` (`8297d0da2215…`): `parse_gitlab_url` on a commit link → `target="commit" ref_confirmed="false" commit="8297d0da2215…"` with no invented `path` and no lost-path note; `get_commit` by that link → `Author`, 1 file, `+32 -11`; `log` by a `/-/commits/` link carrying the 373-character path → the slashed ref split from it, `count="20" truncated="true"`; `blame` by `#L118-126` → `lines="118-126" file_lines="373" groups="2" count="9"` (`7635450e8668` 118–121, `8297d0da2215` 122–126); `compare` → `merge_base="1a0a34cc11ed…"` and `diff_file` → the 2710-byte patch. Six failure shapes behaved as worded: a commit link to `log`, a blob link to `get_commit`, a tree link to `blame`, a history link to `get_file`, a blame link naming no path, and a link disagreeing with `project=` (refused in 1 ms, before anything was resolved). The run also fetched for real — the mirror's stamp moved to `2026-10-19T22:23:31.578Z`, the first call took 2465 ms and the rest 70–200 ms, and no result carried `refresh_failed="true"` — so none of it rested on the cache. The probe ran before the version bump, so the server it spoke to still reported `0.9.0` in its handshake while serving this code; the reported version is pinned by `startup.test.ts`, which asserts the compiled entry point reports exactly `package.json`'s `0.10.0`. Tests-only: blame's binary refusal, `compare`'s unrelated-histories fallback, `compare`/`diff_file` binary refusal, a CRLF line, and a path containing a newline. |
| `v0.10.1` | `f48b150` | Release automation: a `vX.Y.Z` tag re-runs the gate on that commit and, if the tag names `package.json`'s version and sits on `main`, publishes the packed tarball and `SHA256SUMS` as a GitHub release asset. Also the Cursor wiring section. No change to server behaviour. | ✅ Run #1 green in 23 s, every step including both guards. Checked as a stranger: `releases/latest` without a token → `v0.10.1`, assets `gitlab-readonly-mcp-0.10.1.tgz` (88,651 B) and `SHA256SUMS`; both downloaded anonymously; published and downloaded sha256 both `85eb2fc2…174967`; `npm i --prefix <temp> <release URL>` → exit 0, `0.10.1` installed with `dist/index.js` present and a `.cmd` shim created; the shim started and reported `GITLAB_HOST is required`. The guards' **rejection** paths were not run live — a deliberate decision — so the wrong-tag and off-`main` branches are simulated locally and stay unverified against a real tag. |
| `v0.11.0` | `8c46dd8` | Public rollout step 3 — the package on npm. `private` goes; `repository`, `homepage`, `bugs`, `license` and `keywords` were already in place; the README installs from the registry with the release tarball as the offline fallback; `release.yml` publishes the packed tarball with OIDC trusted publishing. The annotation fix from `6a7da12` first reaches users here. The first publish was manual because npm only offers trusted publishing once the name exists, and the tag job skipped that version while creating the GitHub release. | ✅ `npm publish` of the gate's tarball answered `+ gitlab-readonly-mcp@0.11.0`; the registry integrity `sha512-jjmu…MA==` and shasum `4171169a…` are identical to the local pack, and `latest` points at it. Release run #2 was green on the tag's commit with every gate step; its npm step found the version already published and skipped; the GitHub release carries `gitlab-readonly-mcp-0.11.0.tgz` (90,520 B) and `SHA256SUMS`, whose `78adc844…4fa5fa62` matches both the local file and the registry bytes. Checked outside the checkout: a temp-prefix install of `gitlab-readonly-mcp@0.11.0` handshook as `{name: "gitlab-readonly", version: "0.11.0"}` and listed 16 tools (13 read-only), and `npx -y gitlab-readonly-mcp@0.11.0` from an empty directory did the same. The trusted-publisher path itself is unverified: this tag exercised only its skip branch, and the configuration is created before the next release. |

Phase 0 predates the first tag: it was verified by hand — mirror clone succeeded,
`fix/PROJ-7608` was present, `ls-tree` listed files, and
`git show "fix/PROJ-7608:<path>"` printed the file. See the runbook below.

Tooling changes normally take no release, and so no row: they are recorded in
the findings log below and in [`development.md`](development.md). The oxfmt and
oxlint passes of 2026-10-20 changed no behaviour, so neither has a live check —
their gate was `npm run typecheck`, the 325-test suite, `npm run format:check`
and `npm run lint`. `v0.10.1` is the exception: it carried the release workflow,
and it was tagged precisely so that path would be exercised rather than
described.

The public rollout in [`plan.md` §10](plan.md#10-public-rollout) is the same
kind of work — documentation, packaging and distribution — so it takes no row
here either, until one of its steps changes what a user runs. What it learned
on the way goes in the findings log below, and what it will be goes in the
plan. `v0.11.0` is that exception: it makes npm the install, so it has a row
even though the server did not change.

CI is the exception to that rule: it is not a behaviour change, but it only
counts when it runs. Verified live on 2026-10-20 — run #1 failed on one test (the
same-second fixture ordering in the findings log below) and run #2 passed every
step in 40 seconds, `npm ci` to `check:pack`.

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
| 2026-10-19 | **Phase 2a verified live.** After the token fix, a read of `src/index.tsx` on `fix/PROJ-7608` through OpenCode returned both `commit` and `synced_at`. | Freshness is confirmed end to end, not just against the fixture. Tagged `v0.2.1` on `c3c8b57` together with the failure diagnostics. |
| 2026-10-18 | **Phase 2a complete.** TTL + fetch-on-miss freshness implemented and locally tested; the suite moved out of `scripts/` into `test/`. | Exit criterion met: a branch pushed minutes ago is readable and every read reports `synced_at`. Tagged `v0.2.0` on `8fdb109`. |
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
| 2026-10-18 | The `v0.5.0` live check found that the refresh note loses the diagnosis. `refresh` stores the thrown error's `message`, which is only `Failed to fetch <project>.`, while the credentials hint and `git said: …` come from `explainGitError` — which the tool layer applies to a hard failure only. Every result read `[refresh failed: Failed to fetch …]`: it says a refresh failed, not why, so the degradation hid the evidence for its own cause. | The fixture did produce classifiable stderr all along: the test asserted only that the note *said something* (`/Failed to fetch/`), never that it said anything useful, so it passed with the diagnosis missing. The note is now composed through `explainGitError` too, and the test asserts the hint and `git said: …`. **Fixed in `v0.5.1`.** |
| 2026-10-18 | The same check found `synced_at` missing from every result. The stamp is written only by a successful fetch, so a mirror cloned by an older build has none — and the clock deliberately no longer reads `FETCH_HEAD`, which previously supplied an age. | Honest (`lastSyncAt` really is unknown) and self-healing on the first successful fetch, but the answer no longer said how old it was, which is the one thing `synced_at` exists for. **Fixed in `v0.5.1`**: an unmeasured age is rendered as `synced_at="unknown"` instead of being omitted, in all four tools. |
| 2026-10-18 | The `v0.5.1` re-check ran against a **working token**, which turned it into a check of the success path rather than of the two fixes. The first read fetched (2099 ms) and reported `synced_at="2026-10-18T17:48:46.763Z"`; the next three were 74–81 ms and reported the same value from within the TTL; the mirror now carries a 14-byte `mcp-last-sync` reading `17:48:48.101Z`, later than the value the first read printed. | The stamp is written by a real fetch and is well-formed, so the write path is proven live. The later value comes from the *miss* path: `resolve_ref` on a non-existent ref fetches again, so the last writer wins. Reading the stamp back after a restart is proven by unit test only — memory always outranks the file while the process lives, so live output cannot distinguish the two without another restart. |
| 2026-10-18 | Same check: `FETCH_HEAD` is 36377 bytes on disk after a successful fetch, where the failed fetch left it at 0 bytes. | Independent corroboration of the `v0.5.0` finding: git zeroes and stamps that file before a fetch fails, which is exactly what made a rejected fetch look like a fresh sync. |
| 2026-10-18 | Same check: the mirror holds 215 refs, of which the tools report 74 — 13 branches and 61 tags. The remaining 131 are `refs/merge-requests/*`. | Confirms the deliberate scoping of `list_refs` to heads and tags: a mirror copies GitLab's merge-request refs, and they would otherwise swamp a listing. |
| 2026-10-18 | The fetch that failed as rejected credentials at `16:43Z` succeeded at `17:48Z`. The token's real source is `~/.config/opencode/opencode.jsonc`: a single `GITLAB_TOKEN` key in the `gitlab` server's `environment` block (no `glpat-` prefix; the value itself was never read or printed). | A shell variable never reaches the server — OpenCode supplies that environment — so breaking the token to test a failure means editing that file, not `$env:GITLAB_TOKEN`. An **empty** value cannot explain the earlier failure: `loadConfig` throws and the process exits 1, and the server was answering. So the failing server held a non-empty value GitLab rejected. Whether the key was then absent (inheriting an older environment) or present-and-stale is not reconstructible from this side. **Closed: token valid again; exact earlier value unknown.** |
| 2026-10-18 | With the token deliberately set to `no-such-token`, all four tools answered from the cache in ~500 ms (first call 1603 ms): `refresh_failed="true"`, the credentials hint, and `git said: fatal: could not read Username for 'https://gitlab.example.com': terminal prompts disabled`. Counts and commit were unchanged (74 refs, 8 branches, 23 tree entries, `8297d0da…`) and file content was still served. `synced_at` read the stored `17:48:48.101Z` in every result, while `FETCH_HEAD` on disk was zeroed and restamped at `19:03:55`. | The clock fix verified live under a real failure — the one thing the earlier check could not test, because no stamp existed to compare against. The failing fetch moved git's file by 15 minutes and moved ours by nothing. |
| 2026-10-18 | Same run: `resolve_ref` on a non-existent ref failed with `Ref not found: "no/such-branch" … The mirror could not be refreshed either, so a ref created since the last sync would not appear here: <credentials hint> <git said: …>`. | Absence is not claimed as evidence when the refresh failed, and the caveat now carries the full diagnosis rather than a bare "could not be refreshed". This is the one case where a plain not-found would be actively misleading. |
| 2026-10-18 | Same run: every read cost ~500 ms although nothing changed, and the first cost 1603 ms. | The stored stamp was 15 minutes old and the default TTL is 600 s, so each read re-attempted the fetch. No retry flag is involved: a failed fetch records no sync, so the age stays past the TTL and the next read tries again. The fix's own property — a failure writes nothing — is what makes recovery automatic. |
| 2026-10-18 | The fix for the failed-fetch clock: the sync time moved out of git's `FETCH_HEAD` into a `mcp-last-sync` stamp inside the mirror, written only after a fetch returns success — and at clone time, since a clone writes no `FETCH_HEAD`. | Suite grew from 79 tests / 14 suites to 82 / 14: the stamp survives a restart, a failed fetch leaves it alone, and a freshly stamped `FETCH_HEAD` is ignored. Chosen over a one-line empty-file guard, which would infer success from an implementation detail of git rather than a record of one. |
| 2026-10-18 | The registry sketched in the plan carried `lastFetchAt` and `defaultBranch` per project, which would have put a second clock beside the mirror's stamp — the exact shape of the `v0.5.0` defect, where two answers to "when did this sync?" disagreed and the wrong one won. | The registry records **policy only** (`source`, `localPath`, `cloneStrategy`, `freshnessMode`, `freshnessTtlSeconds`); `list_repos` reads age from the stamp. Verified live: after `sync_repo` moved the stamp to `20:52:25.491Z`, the listing reported the new value while `repos.json` contains no timestamp field at all. Plan §3.2 corrected. |
| 2026-10-18 | Mirrors register themselves when they are *used*, not by scanning the cache, so an install that predates the registry answers the first `list_repos` with `count="0"` — even though it has held a mirror for hours. | Deliberate, and observed live as the first call of the check. The alternative is a walk of `mirrors/` plus a `registered=false` state, and a project path cannot be recovered from a mirror directory name with certainty: `mirrorPath` sanitises every character outside `[A-Za-z0-9._-]` to `_`. One empty listing, once, was judged the smaller cost. Revisit in 2c-2 if it bites. |
| 2026-10-18 | `manual` read strictly as "no automatic network access" raised a question the plan never asked: a first-use *clone* is automatic network access too, so a manual project with no mirror would have cloned itself on the first read. | Decided with the owner: `manual` suppresses the clone as well, and the read fails with *"\<project\> is in `manual` freshness mode and has no mirror yet. Run `sync_repo` to fetch it."* `ensureMirror` takes `allowClone`, which only `sync_repo` passes. A test asserts the mirror directory does not exist after the refused read. |
| 2026-10-18 | `syncMirror(project)` had existed since Phase 1 with nothing calling it — `ensureMirror` plus `execFetch` in one method, superseded before it was ever used, and covered by no test. | Removed. `syncRepo` fills the role and reports the resulting `synced_at`, which is what `sync_repo` has to show. Two near-identical methods would have drifted. |
| 2026-10-18 | A new store test asserted that a file's content matched `'main'`, but an earlier test in the same file commits `main-v2` to that branch, so the fresh mirror this test cloned saw the newer content and the assertion failed. The test was wrong, not the code. | Assert the stable part (`export const hello`) rather than a value a sibling test mutates. The second time this project has paid for a test that was wrong about shared state — cf. the fixture-versus-mirror confusion in Phase 2a. |
| 2026-10-18 | **A clone does not hold the refs a mirror does.** After `git clone`, only the branch HEAD pointed at exists as a local ref; every other branch is `refs/remotes/<remote>/*`, where a bare name does not resolve — `git rev-parse fix/PROJ-7608` fails in a fresh clone although the branch is plainly there. 2c-2 exists to read a branch that is *not* checked out, so the feature as scoped would have failed its own primary case. Found while writing the local-clone tests, before the live check. | A read tries the local name first and then `refs/remotes/<remote>/<name>`, the local one winning when both exist so a clone answers with its own branch, unpushed commits included. `list_refs` lists both namespaces, reports each branch once, and skips `refs/remotes/<remote>/HEAD` (a symbolic ref, not a branch). `resolve_ref` calls a remote-only branch a `branch`, with `refname="refs/remotes/origin/…"`. Verified live: the test clone had exactly one local branch (`develop`), and `get_file` on `fix/PROJ-7608` answered from `refs/remotes/origin/fix/PROJ-7608`. |
| 2026-10-18 | Live, the read from the clone reported `synced_at="unknown"` (no fetch had ever run there) while the same ref read through the mirror reported the mirror's stamp — so **one project now has two possible `synced_at` values**, depending on which source answered. | By design: the age shown is the age of the source that answered, and a clone keeps its own `mcp-last-sync` inside its own `.git`, so a miss fetched there leaves the mirror's clock alone. Measured live: the clone's stamp went to `21:45:08.982Z` on the miss and `21:45:28.856Z` on `sync_repo`, while the mirror stayed at `21:44:25.655Z` throughout. "One clock" therefore means one clock *per source*, not one per project — two honest ages, not an inconsistency. |
| 2026-10-18 | `synced_at="unknown"`, open since `v0.5.1` and unit-tested only because that machine had no unstamped mirror, is **verified live**: the first read after `add_repo` reported `synced_at="unknown"`, and `list_refs` did too. | The rendering is real, not fixture-shaped. It doubles as the proof that the read served the clone *without fetching*, since any fetch would have written a stamp. |
| 2026-10-18 | `remove_repo` forgetting a mirror-backed project **does not stick**: the next read registers it again and `list_repos` shows it again. It reads like a failed deletion until one remembers registration-on-use. | Deliberate, and stated on the tool itself: `remove_repo` is how a *local* registration is undone (that does stick, and is the way back to a mirror), and deleting the mirror is the separate `delete_mirror` flag, which a local registration reports as ignored. The 2c-1 wart ("one empty listing, once") is closed by `add_repo`, which registers a project explicitly before its first read: live, `add_repo(project)` with no path gave `source="mirror"` and the project appeared as `present=false` before anything was fetched. |
| 2026-10-18 | "Never touches your working tree" is now measured rather than asserted: `git status --porcelain` was byte-identical (0 bytes) in the clone before and after `get_file`, `list_tree`, `list_refs`, a fetch-on-miss and a `sync_repo`, with a stray untracked file left in place. | Reads are `--git-dir` only; a fetch writes new objects, remote-tracking refs and the stamp into `.git`, which is the accepted decision of 2026-10-18. The fixture asserts the same, so it stays a guarantee rather than a one-off observation. |
| 2026-10-18 | `git grep -z` does **not** make records NUL-delimited. The bytes are `rev:path\0line\0text` + newline, repeated, so the only NULs are *inside* a record and the next record's path is glued to the previous record's text by that newline. The natural reading of "-z = delimiter" would mis-parse every match after the first, silently: the path field would contain the previous match's text. (Read out of the real output with `JSON.stringify`, not inferred from a console echo.) | Parse by splitting on NUL and cutting each token at its **first** newline. The matched line cannot contain one, so the first newline is always the join — which keeps a path containing a newline intact, the reason `-z` exists at all, and lets a byte-cap-torn tail be dropped instead of guessed at. Four unit tests pin the layout, including the newline-in-a-path and torn-record cases. |
| 2026-10-18 | `git grep` exit codes are part of its contract: **1** means "nothing matched" (an answer, not a failure) and **128** means the revision cannot be resolved. Separately, an unmatched *pathspec* also exits 1 with no output — so a mistyped `path` is indistinguishable from a genuine absence of matches. | The ref is resolved before any grep, so 128 is unreachable and a missing ref gets the existing close-match message; exit 1 is handled as an empty answer rather than routed through the error path. The pathspec ambiguity cannot be detected away, so the tool description says so, and a test asserts no matches is not an error. |
| 2026-10-18 | A plain git pathspec's `**` requires **at least one** directory level: here `test/**/*.test.ts` matches 0 files while `test/*.test.ts` matches 10 and `:(glob)test/**/*.test.ts` matches 10. My own test asserted `src/**/*.tsx` matched `src/index.tsx` and failed — the test was wrong, not the code. | `path` is passed through exactly as git defines it, rather than the tool inventing a dialect, and the description points at `:(glob)` for zero-or-more. Both behaviours are pinned by tests so the wording cannot drift from the behaviour. |
| 2026-10-18 | `git log -S` is literal **and case-sensitive** by itself, and `-i` *does* apply to it (measured: 0 commits → 15). Live, the case-sensitive default answered `count="0"` and "(no commits changed how often this appears)" for `orderTotals` while `search` found 13 occurrences of `OrderTotals` — a silent miss of exactly the kind the tool exists to prevent, and the first thing the live check found. | `pickaxe` now runs `-i` unless `case_sensitive` is set, mirroring `search`'s default; the flag is on the schema, and a fixture test asserts the 0 → 1 difference between the two modes. Recorded on the plan's `pickaxe` notes too. |
| 2026-10-18 | The renderer computed `files` from the **returned** slice, so a capped search read `count="5" total="682" files="3"` — a repository-wide claim the answer could not support, since the byte cap and the match cap both cut the list. Found by reading the live output, not by a test; the tests had encoded the wrong belief. | `files` counts every match that was parsed (`files="269"` live, matching a direct `git grep -l` count), so it describes the search rather than the excerpt. A unit test now asserts the count exceeds the returned slice on purpose. |
| 2026-10-18 | `git grep -p` (show the enclosing function) writes `path=line=text` in the normal format — but under `-z` the function header is byte-identical to an ordinary match (`path\0line\0text`), so the marker is gone exactly where the robust parser is. | Confirms the decision to keep match context out of 4a: a `-p` feature must either abandon `-z` and its newline-safe parsing, or distinguish the two some other way. Noted on the plan so 4b starts from the measurement rather than the assumption. |
| 2026-10-18 | `search` *can* fetch on a miss where `list_refs` cannot, because it resolves one ref rather than listing all of them: a ref that does not resolve is a detectable miss, a stale list is not. Measured: a hit inside the TTL ~100 ms, a miss that fetches 1.9–2.1 s, a hit that fetched the mirror 2.4 s. | Kept: `search` is a read, so it inherits the read freshness rules, and the check shows the cost of each path. The one fetch that still has no signal is `list_refs`, unchanged. |
| 2026-10-18 | PowerShell's `>` writes UTF-16LE, so a live-check log redirected with it (`node … > out.txt`) reads back as a binary file and cannot be opened by the file reader; the same output re-encoded as UTF-8 reads fine. | Re-encode scratch logs with `[IO.File]::WriteAllText(path, text, [Text.UTF8Encoding]::new($false))` before reading them, or read the tool output directly. Consistent with the earlier note that the console mangles UTF-8 while files stay correct. |
| 2026-10-19 | **A blob URL does not say where its ref ends.** `/-/blob/fix/PROJ-7608/src/index.tsx` has three plausible splits and the ref may itself contain slashes, so no parser can decide from the URL alone. | The remainder after `blob`/`tree` is matched against the source's real refs (branches and tags, no fetch) and the **longest** known prefix followed by `/` or the end wins — the greedy resolution GitLab itself does. `?ref_type=tags` breaks a branch/tag tie; with no match the first-segment reading is kept, the URL reports `ref_confirmed="false"`, and the read fails with the usual not-found message and suggestions. Verified live: `fix/PROJ-7608` split correctly and reported `ref_kind="branch" ref_confirmed="true"`. |
| 2026-10-19 | **`-l -z` and `-c -z` are different layouts, and neither is the match layout.** `-l -z` writes `rev:path\0` with no newline at all, so NUL is the only separator; `-c -z` writes `rev:path\0count\n`, where the count sits where `line` sits and no text follows. | Read from the bytes, then one parser per shape: `parseGrepPaths` splits on NUL, drops the final (empty or torn) token and strips the `sha:` prefix; `parseGrepCounts` splits on NUL, then cuts each record at its first newline. Measured on `data-testid`: 111 KB of matches, 28 KB of paths, 29 KB of counts — so both cheap modes stay exact where the match list would have been capped. |
| 2026-10-19 | **`-C`/`-W` cannot say which line matched.** Under `-z` their context lines use the match layout exactly (`path\0line\0text`), so after parsing a marked line is indistinguishable from its neighbours — the same shape of problem `-p` had in 4a. | `context: N` is assembled in TypeScript: for the matches actually displayed (grouped by file, capped at 20 files) one `git show <commit>:<path>` is read — the `get_file` path — and lines within `N` of a match are printed, the matched line marked `>`, overlapping ranges merged and distant ones separated by `…`. Verified live on the pilot: hunks with `>` and `…`, and `N=0` left the output unchanged from 4a's. |
| 2026-10-19 | **`cloneStrategy: "blobless"` was stored and honoured nowhere.** The registry parsed it and `list_repos` did not say so; `resolveSource` never looked at it, so a blobless mirror on disk would have been read as if it were full and failed later as a bad ref or a missing object — a policy value nothing implements, failing somewhere else. | Refused by name where a source is resolved: the error quotes the project, the value and the fix, and the value stays in `repos.json` (dropping it would hide what was written). `list_repos` prints `clone_strategy=<value>(unsupported)` rather than a clean row. Tests cover both the refusal and the repair by hand. |
| 2026-10-19 | **A byte cap can split a UTF-8 character.** Cutting git's stdout buffer at exactly the cap and decoding it invents `U+FFFD` for the half character — a character that never existed in the repository, presented as file content. | `decodeOutput` drops the trailing character the cut left incomplete instead of fabricating one. The first implementation dropped a *complete* character at the boundary and the new test caught it; the rule is now pinned by unit tests and by a fixture branch whose content ends in a multi-byte character. |
| 2026-10-19 | **`pickaxe`'s `truncated` flag merged two causes.** A capped commit list and a stdout stream cut at the byte cap printed the same footer, which advised raising `limit` even when more bytes, not more limit, were needed. | `outputTruncated` is separate: `truncated` still means "the limit hid commits", and the byte-cap footer says the history stream was cut at the size limit rather than advising a higher `limit`. The renderer prints whichever applies. |
| 2026-10-19 | **Live: four parallel reads shared one fetch.** Four concurrent first reads on a stale mirror all reported the same `synced_at`; the first paid the fetch and the rest answered behind it. | The fetch decision is re-checked inside the per-source lock, so callers queued behind an in-flight fetch do not fetch again — the design's in-lock re-check, verified live rather than only in the fixture. |
| 2026-10-19 | **Live: a miss fetch also serves the suggestions.** A deliberately wrong ref cost one fetch (the mirror's stamp advanced 26 s) and then produced five real branch suggestions. | Intended: a missing ref is a detectable miss, so `ref not found` may be answered *after* a fetch — and that fetch is what makes the suggestions current. One deliberate fetch per miss, not a stampede. |
| 2026-10-19 | **After `opencode service restart` the MCP catalog was briefly empty**, then listed 11 tools; a probe run inside that window would have concluded the server had failed to start. | A live probe must allow a beat after a restart. The tool list the assistant can see is itself the probe: a missing tool means the restart has not landed yet, not that registration is broken. |
| 2026-10-19 | The restarted server re-ran the released 4b shapes against the pilot as a single probe: `get_file` by URL → `lines="118-126" file_lines="373"`, `parse_gitlab_url` (resolved) → `ref_kind="branch" ref_confirmed="true"` at `8297d0da22…`, `search output="count"` → `count="100" total="682" files="269"`, `output="files"` → 3 paths, `context=2` → `>`-marked hunks with `…`, and `resolve=false` → the `[not resolved: …]` note. | The one place the release could still be wrong — a stale `dist/` — is ruled out: the running process answers with the new code. The version string is not verifiable this way, because MCP reports it in the handshake rather than in tool output; `startup.test.ts` remains its guarantee. |
| 2026-10-19 | **A link can be well-formed and still name a missing path.** The same probe started from a URL with the right ref and a wrong directory: `parse_gitlab_url` reported `ref_confirmed="true"` and the commit — correctly, since it confirms the *ref* — and only `get_file` refused it (`Path not found: "src/components/Report.tsx" at "fix/PROJ-7608" …`). Unlike a missing ref, that error carries no close-match suggestions. | Left as it is: checking every path would mean walking the tree for a call that only needed to name the link, and the field is named `ref_confirmed`. Recorded because the wrong path was mine and the shape reads easily as "the link is good"; a path-level hint or a `path_confirmed` flag is a candidate for a later phase. |
| 2026-10-19 | **`/-/commit/<sha>` and `/-/commits/<ref>/<path>` are not file links, and 4b had nothing to hand them to.** A commit link names a revision with no path; a history link names a ref *plus* a pathspec. Reading either through `get_file` would have read something the link did not point at, so 4b refused both by name — leaving a pasted commit link readable only by hand. | 3d grew `UrlTarget` to `file \| directory \| commit \| log`, and the five readers route every refusal through one `linkTargetRefusal`, so a link handed to the wrong tool names the tool that reads it (`"…" is a commit link; use get_commit for it.`). Verified live: four wrong-tool shapes, plus the project-disagreement check (1 ms, before anything was resolved) and a blame link naming no path. |
| 2026-10-19 | **A commit link has no path, so two "helpful" renderings would have been lies about it.** `formatUrl` printed `path="/"` for any link with an empty path, and warned that "the path may have lost part of it" whenever the ref was unconfirmed — both defensible for a blob link and false for a commit link, whose `ref` is the revision and which carries no path at all. `ref_confirmed="false"` is also expected there: a sha is not a ref of the project. | The path attribute and the lost-path note are suppressed for `target="commit"` (a history link with no pathspec still prints `path=""`), and whether the revision exists is answered by `commit="…"` rather than by `ref_confirmed`. Pinned by unit tests on the renderer and seen live (`target="commit" ref="8297d0da2215…" ref_confirmed="false" commit="8297d0da2215…"`). |
| 2026-10-19 | **The "token rejected" state of the 4b check does not hold now.** The 3d probe authenticated and fetched: the first call took 2465 ms and the rest 70–200 ms, the mirror's stamp advanced from `2026-10-19T20:52:55.246Z` to `2026-10-19T22:23:31.578Z`, and no result carried `refresh_failed="true"`. | The earlier row stands as a description of a broken token, not of the token. This phase's live check therefore rests on freshly fetched data rather than on the cache, which is the stronger reading — and it removes the last doubt about whether `synced_at` movers were test-shaped. |
| 2026-10-19 | **In this harness a tool result with `isError` surfaces as the failure of the whole `execute` snippet**, not as a value, and a successful call arrives as its text — a plain string, not `{ content: [...] }`. | A live probe that deliberately exercises a refusal must `try`/`catch` each call and report the caught message, or the successful output of the same snippet is lost. Learned by losing two probe reports to exactly that, and fixed by wrapping every call. |
| 2026-10-20 | **The README's tool list had been stale since phase 3.** The "Wire into OpenCode" section listed eleven tools — the phase-2c set — while *Usage* had grown to sixteen. Nothing compared the two, and nothing failed when they disagreed. | The list is gone; the capability table is checked against the `server.registerTool` calls (16 names) as part of the phase check. A list of names is worth keeping only where something can fail when it goes out of date. |
| 2026-10-20 | **Two examples had been wrong for as long as they existed, and reading them could not show it.** `log` and `blame` rows were documented as dates (`2026-10-15`); the tools print full ISO timestamps (`2026-10-15T12:32:33+01:00`). `list_tree` and `list_refs` rows looked space-aligned; git separates the columns with tabs. | Re-running the examples is a verification step, not a nicety: both errors surfaced only when the text was compared with real output. The examples now carry the format the tools print. |
| 2026-10-20 | **Five facts each had two to four homes** — the tool list, tool semantics, phase history, the source layout, and freshness behaviour. That duplication is why the README grew past 600 lines while saying little a user could not get elsewhere. | One owner per fact: code for semantics, README for getting started and examples, `internals.md` for behaviour, `development.md` for build/release/layout, the plan for pending design, history for evidence. The README's duplicate of each was deleted, not moved. |
| 2026-10-20 | **"One home" has a deliberate exception: the README's six-entry glossary.** `synced_at`, `refresh_failed`, `truncated`, `ref_confirmed`, `merge_base="none"` and `(no matches)` each get one line in the README so a human can read an agent's answer, while `internals.md` explains the mechanics. The duplication grep therefore still finds `synced_at` in four files. | The four are four roles — explanation, quick reference, design decision, evidence — not four explanations. Recorded so the next run of the check does not mistake the split for drift and "fix" it by deleting the glossary. |
| 2026-10-20 | **`Measure-Object -Line` undercounts these files.** It reported the README as 527 lines when it was 637, and `history.md` as 499 when it was 568 — it does not count the same way `(Get-Content file).Count` does. | Use the array count whenever a size is quoted. Two size claims made earlier in this work were wrong until they were rechecked. |
| 2026-10-20 | **oxfmt is pre-1.0 (0.74.0), so a caret range is a loaded gun.** A minor bump can reformat the whole repository, and it would land inside whatever unrelated change happened to trigger it. | Pinned exactly — `"oxfmt": "0.74.0"`. A bump becomes a deliberate commit of its own, the way a release is. |
| 2026-10-20 | **`printWidth: 80` would have cost five times the diff of 100.** Measured on copies of the tree: at 80, 28 files and 2760 lines; at 100, 20 files and 574. 911 lines already sat in the 81–100 band. | `printWidth: 100`. That band was drift, not a chosen style, and wrapping it would rewrite nine hundred lines that read fine. The measurement lives in `development.md` so the next person re-runs it rather than guessing. |
| 2026-10-20 | **Oxfmt formats Markdown natively, and does it badly for this repository.** It pads every table cell to a uniform width (rows ran past 160 characters) and rewrote the `mcp.servers` example inside a fence, adding trailing commas and re-indenting it. | `ignorePatterns: ["**/*.md"]`. 504 of the 848 lines a full pass would have removed were docs, and none of them were wrong — the README and `docs/` are hand-wrapped at 79 columns on purpose. |
| 2026-10-20 | **`.git-blame-ignore-revs` cannot contain the SHA of the commit that adds it**, which is the whole point of the file. | Two commits: the reformat, then the ignore file. Verified with `git blame --ignore-revs-file .git-blame-ignore-revs`: `src/config.ts:60` resolves to `77b180a6` rather than to the format commit, so blame still names the author. |
| 2026-10-20 | **A new extension-less dotfile is not covered by the `eol=lf` rules.** `.gitattributes` matches dotfiles by name, so `.git-blame-ignore-revs` fell under `text=auto` and git warned that `core.autocrlf` would rewrite it to CRLF on the next checkout — the one line-ending drift the project takes trouble to avoid. | Listed explicitly in `.gitattributes`, beside `.editorconfig` and `.gitignore`. |
| 2026-10-20 | **The oxc and hook tooling would raise the Node floor above what the server needs.** `oxlint` needs `^20.19` or `>=22.12`, `lint-staged` `>=22.22.1`, `@commitlint/cli` `>=22.12`; `engines` still says `>=20`, and Node 20 reached end-of-life on 2026-04-30. | **Changed.** `engines` is `>=24`, `.nvmrc` pins 24.21.0 so `nvm use` matches it, and the README's requirement line moved with them — three files that would have contradicted each other if only one had moved. Only oxlint's constraint is real; the hooks are still deferred. `.nvmrc` needed an explicit `.gitattributes` entry, which is the extension-less-dotfile trap this file already recorded. |
| 2026-10-20 | **The first oxlint run found 29 issues across six rules, and exactly one was a hazard.** Four `path` locals in `repoStore.ts` shadowed the `node:path` import — in the file whose job is manipulating paths, so a reader cannot tell which `path` a line means. The rest were style (shadowing in tests, a function that could be hoisted, a deliberate `new Array`) or mechanical (five mutating `.sort()` calls and one pointless concatenation). | Renamed to `entryPath` / `filePath`; a `test/**`-scoped override turns off the two naming rules, where a helper called `store` or `client` reads better beside its test than an invented name; five per-line suppressions carry a reason. Running in report mode *before* fixing anything is what made the triage possible — `--fix` first would have buried the shadowing under 24 mechanical edits. |
| 2026-10-20 | **`toSorted()` needed a compiler setting the runtime did not need.** The typings live in `lib: ES2023`, so `tsconfig.json` moved up from `ES2022`, while `Array.prototype.toSorted` has shipped since Node 20 — below the floor that was already claimed. What the compiler believes the language offers and which Node actually runs the code are two separate questions. | `"lib": ["ES2023"]`, nothing more. Worth remembering when `engines` moves: this setting is about types, not about the runtime floor. |
| 2026-10-20 | **The `import` plugin resolved every NodeNext specifier, which is what I expected it to get wrong.** `import … from "./x.js"` names a file that exists only as `x.ts` before compilation, and a resolver ignoring `moduleResolution: NodeNext` reports all of them as unresolved — the usual reason this rule gets switched off in an ESM TypeScript project. | Zero `import/no-unresolved` findings in the first run, so the plugin stays on and is now load-bearing rather than decorative. Verified by the run, not assumed: if it turns red after a TypeScript or oxlint bump, this row is what to reread before disabling anything. |
| 2026-10-20 | **`eslint` in oxlint's `plugins` array is a no-op.** `oxlint --print-config` drops it — the core ESLint rules are always on — so naming it changes nothing while implying it is a plugin that could be removed. | The config lists only the five entries that add rules: `typescript`, `unicorn`, `oxc`, `import`, `node`. The effective plugin set is now readable from the file instead of restating a default. |
| 2026-10-20 | **A suppression directive has to spell the rule the way the report does.** Core rules are unprefixed (`no-control-regex`); plugin rules keep their namespace (`unicorn/no-new-array`). A directive naming the wrong one suppresses nothing, and the finding stays visible only if someone reads the run. | Both shapes appear in the tree and in `development.md`'s example. `reportUnusedDisableDirectives` adds the second signal: a directive that matches no finding is reported as unused, so a stale or mistyped suppression does not sit there quietly claiming to be needed. |
| 2026-10-20 | **`engines` now says 24, but the type definitions argue for 26.** `@types/node` is `^26.6.5`, so `tsc --noEmit` accepts Node 26 APIs that a Node 24 runtime would not have. It is the same shape as the `lib: ES2023` question two rows up: what the compiler believes and what the runtime provides are separate questions. | Left alone, and noted rather than quietly changed: nothing in the code has reached for a newer API, and the types running ahead of the floor is a normal arrangement. If a read ever fails on an API that typechecked, this row is the first thing to check. |
| 2026-10-20 | **The CI plan's packaging claim was backwards, and only measuring showed it.** The plan said that without a `files` field npm falls back to `.gitignore` — which lists `dist/` — so the tarball would omit the entry point, and the check was written to catch exactly that. Measured with npm 11.19: **79 files, `dist/index.js` among them**, plus `src/`, `test/`, `docs/`, every dotfile and both tsconfigs. No `.npmignore` exists. | The check asserts the tarball's *shape* instead — `dist/` plus the metadata npm always adds, nothing else. Red on 45 unexpected files, green on 34 once `files: ["dist"]` landed. The first version of the check passed before any fix, which is precisely what the red-before-green rule exists to catch; the plan's paragraph was corrected rather than left to mislead the next reader. |
| 2026-10-20 | **The first CI run failed on one test, and the test was wrong rather than the code.** `log` asserted `["merge feat/MERGE", "branch work", "initial"]` and got `["merge feat/MERGE", "initial", "branch work"]`. The fixture made its commits back to back, so on a faster Linux runner two of them landed in the same second — and at the same second `git log`'s newest-first order is not creation order. Nothing in the server differs across platforms. | Fixture commits now carry explicit `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE`, one minute apart from a fixed base. Reproduced locally by collapsing that spacing to zero, which produced the same actual/expected pair on Windows — the diagnosis is measured rather than inferred from the diff. Side benefit: fixture dates are reproducible, so a date can be asserted by value instead of by shape. |
| 2026-10-20 | **A classic PAT with `repo` scope cannot push a workflow file.** The first push of the CI commit was rejected: *refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope*. The token authenticated fine for everything else — the scope is checked only when the push touches `.github/workflows/`. | Added `workflow` to the existing token; the value did not change, so nothing had to be moved between the config and the browser. Worth knowing before the next repository gets its first workflow, and worth checking with `x-oauth-scopes` rather than guessing from a 403. |
| 2026-10-20 | **The server installs as a package now, so no absolute path survives in anyone's config.** `npm pack` + `npm i -g` puts `gitlab-readonly-mcp` on `PATH`; OpenCode resolves the `.cmd` shim and spawns `C:\nvm4w\nodejs\node_modules\gitlab-readonly-mcp\dist\index.js`. Verified from a scratch directory over stdio — `initialize` reported `gitlab-readonly` 0.10.0, `tools/list` returned all sixteen, `list_repos` answered from the existing mirror — and the process table showed the global path, not the checkout. | Two caveats recorded instead of discovered later: under `nvm` the global prefix sits inside the active Node version, so switching versions hides the command; and `check:pack` now also asserts that every `bin` target is in the tarball (red on `dist/missing.js`, green on the real path). A command that runs a file the package does not ship is precisely what the old shape-only check could not see. |
| 2026-10-20 | **A gate whose exit code is not captured is a gate that did not run.** The local check printed `npm run format:check` piped to `Select-Object -Last 1`, which shows oxfmt's summary and throws away the status. Three files the scrub had left unformatted looked like a pass; the first CI run on the published repository failed on exactly those three. | Every step in the manual gate now ends with an explicit `exit=`, and the fix was a one-line reflow of three `describe()` calls. The same hole would have hidden a failing test just as quietly: `Select-Object -Last 1` discards the exit status as reliably as it discards the output. |
| 2026-10-21 | **A `.cmd` shim is not a command to a process started without a shell — but whether a client starts one is an observation, not a rule.** A shell-less `child_process.spawn` of `gitlab-readonly-mcp` gives `ENOENT`; with `cmd /c` it starts and reports `GITLAB_HOST is required`. The first version of this row concluded that Cursor on Windows therefore starts servers directly; a real Cursor build then ran `"command": "npx"` - also a `.cmd` shim - on Windows without a wrapper. | The Cursor section now shows the `npx` form that was tested and keeps `cmd /c` as the fix when `ENOENT` appears in `MCP Logs`. The mechanism is what survives: a command that works in a terminal is not evidence that an application can start it, so read the logs rather than trusting either rule. |
| 2026-10-21 | **A git-URL install of a repository without `dist/` produces no command at all.** `npm i -g git+https://…` exits 0 and reports "added 96 packages", but `files: ["dist"]` packs the clone into three files — `package.json`, `README.md`, `LICENSE` — and npm creates a `bin` shim only when its target exists, so `.bin` holds no `gitlab-readonly-mcp`. The user reads success and gets "not recognized". | Measured: `npm pack git+…` → 9,307 bytes, three files; an install into a throwaway prefix → no shim at all, plus 96 packages of dependencies for code that is not there. This is what the release asset exists to avoid, and why a `prepare` script was declined: every install would then need `typescript` and a build. |
| 2026-10-21 | **A tag push runs the workflow file from the tagged commit.** A release workflow that exists only on another branch is invisible to the tag, and one merged after the tag is pushed is equally ignored — the order is workflow first, tag second, or nothing happens and nothing complains. | It set the order of this release: `release.yml` was merged and seen as `state=active` before `v0.10.1` existed. Reversing it would have produced a tag, no run and no error — the plugin would have looked installed. |
| 2026-10-21 | **`npx <name>` runs an installed binary before it consults the registry, so a config built on an unpublished name works exactly where it was tested and nowhere else.** The package is not on npm — `gitlab-readonly-mcp` answers 404 — yet `npx -y gitlab-readonly-mcp` started the globally installed server with no registry request: in a scratch directory it printed the server's own `GITLAB_HOST is required`, exit 1, and nothing about a 404. A colleague who copies the snippet without the install gets the 404 instead, and a client that swallows it shows a server with no tools. | Both halves measured, then written down as a distinction rather than a correction: the README says the `npx` form is post-install, and gives `npx -y --package <release tarball URL> gitlab-readonly-mcp` for a machine without one — 1 s on the second run, so npm's cache does the work rather than a per-start download. A client config takes the same three arguments in `command`. |
| 2026-10-21 | **A tag-triggered workflow's badge reports its last tag, not the project's health.** `release.yml` renders "Release | passing" even when nothing has been released for a while, and it turns red for a failed tag while the previous release stays installable — the opposite of what the colour suggests to a reader. | The front page got a version badge instead (shields `github/v/release`, "Release | v0.10.1", linking to `releases/latest`), which shows what the CI badge cannot: whether the version `Install` hard-codes is still the newest one. Its cost is one third-party image, so a network that blocks shields.io shows a broken badge where github.com itself still resolves. |
| 2026-10-21 | **`--generate-notes` lists merged pull requests, not commits.** On a repository without PRs the generated section is a single "Full Changelog" compare link, so the release body said almost nothing about what changed; the fixed preamble carried the install line and the one useful warning. | Accepted rather than patched: the compare link is a truthful pointer for a one-person repository. The body is composed from `gh api …/releases/generate-notes` plus a preamble instead of `gh release create --generate-notes --notes`, so there is one shape to reason about. Prose per release stays a decision for when a change deserves it. |
| 2026-10-21 | **The README hard-codes the release version in five places, and the release procedure never mentioned them.** The install line at the top of the page, the install command under *Install*, the `npm pack` example's file name and the `npx` form's tarball URL all name `v0.10.1`. `git log -S 'v0.10.1' -- README.md` shows they arrived with the 0.10.1 *documentation* commits rather than with a release commit, so nothing in the bump would have moved them — and a page that installs the previous release still looks current, because the front page's version badge answers "what was released" while the command under it answers "what would a reader install". | `test/readme.test.ts` makes the page a checked claim: it fails when a pinned version is not the one `package.json` declares, and when the install command is no longer above the first heading. Verified both ways — green on the real page, and red on a mutated copy in a scratch directory, which failed with *"the README installs v0.9.9, but package.json says 0.10.1"*. The badge is the human check; the test is the one that fails a build. The release checklist in `development.md` now says to bump both in one commit. |
| 2026-10-21 | **The token reaches git on its command line, so it is visible in the process list while a call runs.** `src/git.ts` passes `-c http.extraheader=Authorization: Basic <base64(oauth2:token)>` as an argument. That is exactly what keeps the token out of `.git/config` — and it puts the token in the child's argv, where any process running as the same user can read it for the life of the call. The README states the `.git/config` guarantee and says nothing about this. | Recorded rather than changed, and the change is not obvious: moving the header to `GIT_CONFIG_COUNT`/`GIT_CONFIG_VALUE_0` takes it out of the process list and into the process environment, which is the same audience on Windows and a narrower one on Linux — a real improvement, but a behaviour change to a verified auth path for a small exposure. It is written down in `plan.md` §10 as the residual risk the rollout's `SECURITY.md` has to state, because the audience this rollout targets asks exactly that question. |
| 2026-10-21 | **The official GitLab MCP server's real constraint is the token type, not the instance version.** Its docs (generally available; Free/Premium/Ultimate on GitLab.com, self-managed and Dedicated) say it accepts OAuth tokens with the `mcp` scope or fine-grained PATs with the MCP tool resource, and rejects legacy PATs, project access tokens and group access tokens with `403 insufficient_scope`; it also has to be enabled per instance or top-level group. The README and plan framed the niche as "self-managed and older than 18.3", which excluded gitlab.com and undersold the reason to choose this. | Reframed the README first screen, plan §2 and §10 around the token type, named gitlab.com as supported, and kept the version as one of three reasons. Corrected two claims found while checking: Advanced Search (and the API's `blobs` scope) is Premium/Ultimate, so the gap is Free or unconfigured instances rather than "Free/Premium"; and the official server's 60/min Free limit exists only from 19.5 behind feature flags (off by default), while GitLab.com's authenticated Git HTTPS limit is 10,000/min (5,000/hour sustained) — so the README says "one fetch per TTL" instead of claiming no request budget at all. Verified live: the compiled entry with `GITLAB_HOST` empty exits 1 with the new message, and the startup test booted the server with `GITLAB_HOST=https://gitlab.com` and listed all sixteen tools. |
| 2026-10-27 | **An automated MCP catalogue rated the server F on a name-based reading, and two of its sixteen tool classifications were wrong.** PolicyLayer's record (free API, scanned 2026-10-21) filed `parse_gitlab_url` as Execute/High with boilerplate about starting dozens of builds, and `resolve_ref` as Write/Medium with boilerplate about creating resources; both are read-only and both already carried `readOnlyHint: true`. It reported 0 parameters for tools that take optional arguments, so it read names and a truncated first line of each description, not the input schemas. Its grade is peak-based, so `remove_repo` alone keeps the letter at F: its `delete_mirror` flag does delete a cached mirror, though only inside the cache and never a registered clone. Separately, `add_repo` and `sync_repo` set `readOnlyHint: false` and omitted `destructiveHint`, and the spec says a client should assume destructive when the field is absent, so clients that trust annotations were also told a registry write and a fetch could destroy data. | `add_repo` and `sync_repo` now state `destructiveHint: false` (`6a7da12`); `test/protocol.test.ts` fails when a tool omits `readOnlyHint`, or when a tool that is not read-only omits `destructiveHint`, and the guard was seen red with the field removed and green after restoring it. `package.json` gained `license`, `repository`, `homepage`, `bugs` and `keywords` (`067963e`), which npm and identity-checking registries read. `remove_repo` keeps its destructive hint, the grade stays F, and the catalogue was not contacted, because `delete_mirror` deletes only a rebuildable cache: a scope disagreement, not a defect to design around. Suite: 328 → 329 tests. |
| 2026-10-27 | **npm stages a first publish behind `0.0.0-stage`, and the CLI reports success before the version exists.** `npm publish .\gitlab-readonly-mcp-0.11.0.tgz` printed `+ gitlab-readonly-mcp@0.11.0`, but the registry held only `0.0.0-stage`, with `latest` pointing at a 341-byte placeholder; `0.11.0` appeared 2 min 38 s later. `npm stage list`, filtered and unfiltered, returned nothing while the version was in flight, so there was no stage id to approve. This is the shape of npm CLI issue #9889, where a first publish is staged and cannot be cleared. | No action: the version landed on its own and the placeholder is harmless once `latest` moves. The check to run before announcing any first publish is `npm view <name>@<version> version`; the CLI's success line is not that check. The placeholder stays as `0.0.0-stage`. |
| 2026-10-27 | **Trusted publishing cannot be configured for a package that does not exist, so the first npm publish is manual.** npm's settings page only offers the trusted publisher form for an existing package, and npm CLI issue #8544 for OIDC first publishes is still open. | The first version was published by hand, and `release.yml` already carries `id-token: write` plus a skip for an existing version, so every later tag can publish from CI with provenance and no stored token. The trusted publisher has to be created just before the next tag: an unvalidated configuration expires after two days. |

---

## Per-phase artifacts

What each phase actually touched. The plan keeps only the design; this is the
blow-by-blow.

### Phase 5 artifacts

- `README.md` (`79034c1`) — 637 → 385 lines. Deleted: the intro blockquote, the
  21-call catalogue, the roadmap, development/versioning/layout, and the
  per-tool prose the descriptions already own. Kept verbatim: requirements,
  install, configuration, wiring, troubleshooting, security. Added: a 16-row
  capability table, a seven-example quickstart, gotchas, a six-entry attribute
  glossary, and a "Read more" pointer.
- `docs/internals.md` (`d0c93fb`, new, 123 lines) — why git, sources (mirror vs
  registered clone), freshness (the three modes, fetch-on-miss, the `list_refs`
  exception, per-source lock and stamp), failed refresh, the read-only
  guarantee, and the blobless refusal. Rationale links to the plan rather than
  being copied into a third place.
- `docs/development.md` (`65ba524`, new, 116 lines) — build and test, the
  fixture, versioning, the hand release, the "adding a tool" path, and the one
  source layout.
- `docs/plan.md` (`65ba524`) — the source-layout block replaced by a pointer
  (−49 lines), plus the phase-5 row and status that say the phase takes no
  release. Its finished-feature design was deliberately left alone.
- `SECURITY.md` (new, 120 lines, 2026-10-27) for rollout step 5: what runs, the
  token's path through the process and its brief visibility to same-user
  processes, what the server writes, the one host it connects to, repository
  content as untrusted input, the four residual risks, and the tests behind the
  claims. Linked from the README's Security section. No code change and no
  release.
- `src/` — untouched. No service restart (nothing the server reports changed)
  and no tag.
- Verified: `npm run typecheck` clean; `npm test` 325 tests / 56 suites, 0 fail.
  Every quickstart example re-run against `example-app` @ `fix/PROJ-7608` —
  which is how the timestamp and separator errors surfaced and were fixed. All
  16 tool names checked against the `server.registerTool` calls; the values printed
  in the examples (`ttl=600`, `max_lines="500"`, `max_files="100"`,
  `context="3"`) checked against `repoStore.ts`.

### Phase 3 artifacts

- `docs/plan.md` §4 — the five tools' design, written and reviewed **before** any
  code (`5dfc879`), including the measured `--name-status`/`--numstat` split (the
  flags do not combine), the `--numstat -z` rename record with its empty path
  field, the pathspec-narrows-rename-detection trap, and the decision that
  `compare` is a capped summary and never a patch. §7 split the phase into 3a–3d.
- `src/repoStore.ts` — `log`, `getCommit`, `blame`, `compare`, `diffFile`; the
  two-pass status/count pair and their parsers, `parseBlamePorcelain`,
  `parsePorcelainLog`, `resolvePair`, and `diffFiles` (shared with `getCommit`
  from 3c); `DEFAULT_LOG_LIMIT` (20, hard 200), `DEFAULT_BLAME_MAX_LINES` (500,
  hard 5000), `DEFAULT_COMPARE_MAX_FILES` (100, hard 1000), `HARD_DIFF_CONTEXT`
  (10) and the binary-patch constant.
- `src/tools/history.ts` — new: the five tools and `formatLog`, `formatCommit`,
  `formatBlame`, `formatCompare`, `formatDiffFile`, `parseLineSpec`; from 3d, `url`
  on `log`/`get_commit`/`blame`, with `rev`/`path` optional because a link can
  supply them and the link's `#L` anchor winning over `lines`.
- `src/url.ts`, `src/tools/url.ts`, `src/tools/files.ts` — `UrlTarget` grew
  `commit` and `log`, both link shapes are parsed (the ref/path split is the same
  one blob links already used), and one `linkTargetRefusal` words every
  wrong-tool refusal, with `get_file`/`list_tree` rerouted through it.
- `src/server.ts` — instructions name the five tools and which link goes to which.
- `test/history.test.ts` — new: store, parser and renderer tests for all five
  tools; `test/fixture.ts` gained `addOrphanBranch` (unrelated histories, for
  `compare`'s fallback) and a mid-file edit branch.
- `test/url.test.ts`, `test/protocol.test.ts` — commit and history link parsing,
  the two "names nothing" refusals, `resolveUrl` for both shapes, `formatUrl` and
  `linkTargetRefusal`, and the URL-driven tool calls plus four refusal shapes over
  the real MCP surface.
- Suite: 254 tests / 46 suites at `v0.9.0` → 318 / 55 at 3c → **325 / 56** at 3d.
- Commits: `5dfc879` the design, `26d8e77` `log` + `get_commit`, `03249ed`
  `blame`, `7973f57` `compare` + `diff_file`, `862d0fc` the link routing.
- Live checks, all against `example-app` @ `fix/PROJ-7608` (`8297d0da2215…`):
  3a and 3b probed `log`, `get_commit` and `blame` when they landed (the merge
  commit `1a0a34c` reported `merge="true"` with two parents and `files="0"`; the
  blame of lines 118–126 split into `7635450e8668 … 118-121` and
  `8297d0da2215 … 122-126` with `file_lines="373"`). 3c probed `compare` →
  `merge_base="1a0a34cc11ed…"`, one file `M … +32 -11`, and `diff_file` from that
  base → the branch's 2710-byte patch.
- **3d verified live, after `opencode service restart`** — the assistant's own
  tool list went from 11 gitlab tools to 16, which is the probe that the restart
  landed. Through the wired-up server: `parse_gitlab_url` on a commit link →
  `target="commit" ref="8297d0da2215…" ref_confirmed="false" commit="8297d0da2215…"`
  with no `path` and no lost-path note; `get_commit` by that link →
  `rev="8297d0da2215…" parents="1a0a34cc11ed…" author="Author <…>" files="1" additions="32" deletions="11"`;
  `log` by `/-/commits/fix/PROJ-7608/<373-line path>` → `ref="fix/PROJ-7608"`,
  the whole path split off as `path=`, `count="20" truncated="true"`; `blame` by
  `/-/blame/…/Report.tsx#L118-126` → `lines="118-126" file_lines="373" groups="2" count="9"`
  with the two real groups. Refusals, as worded: commit link to `log`, blob link
  to `get_commit`, tree link to `blame`, history link to `get_file`, a blame link
  with no path, and a link that disagrees with `project=` (refused in 1 ms, before
  resolution). The same run fetched for real — the mirror's stamp advanced to
  `2026-10-19T22:23:31.578Z` with no `refresh_failed` — so none of it rested on a
  stale cache. Tests-only remain: blame's binary refusal, `compare`'s
  unrelated-histories fallback, `compare`/`diff_file` binary refusal, CRLF and a
  path containing a newline.

### Phase 4b artifacts

- `docs/plan.md` §4 — the URL, output-mode and context design written and reviewed
  **before** the code (`ab28ccd`), including the measured `-l -z` / `-c -z` layouts
  and the decision to assemble context in TypeScript rather than trust `-C`.
- `src/url.ts` — new: the pure parser/splitter `parseGitlabUrl`,
  `resolveUrlParts`, `parseLineAnchor` and `hostOf`, including the empty-host rule
  that keeps `file://` fixtures testable. No registry, no network.
- `src/tools/url.ts` — new: `parse_gitlab_url` and `formatUrl`
  (`target`, `ref_confirmed`, `ref_kind`, notes).
- `src/repoStore.ts` — `resolveUrl` (that greedy longest-prefix resolution over
  branches and tags), the three `-z` parsers (`zRecords`, `parseGrepPaths`,
  `parseGrepCounts`), the context helpers (`contextRanges`, `contextLines`,
  `contextFor`), `sliceLines`, `assertSupportedStrategy`, `RepoSummary.cloneStrategy`
  and `PickaxeResult.outputTruncated`.
- `src/tools/files.ts` — `url` and `lines` on `get_file`, `formatRangeBody`, the
  directory-link and ref-without-path refusals, the URL/`project` disagreement
  check, and the byte-cap notes.
- `src/tools/search.ts` — `output` and `context` on `search`, per-mode rendering,
  hunk assembly, and the split truncation footers for both tools.
- `src/tools/repos.ts` — `clone_strategy=<value>(unsupported)` in the listing.
- `src/git.ts` — `decodeOutput()`, and the capped stdout read path that uses it.
- `src/registry.ts`, `src/server.ts` — `CloneStrategy` semantics (blobless parsed
  and kept, refused on use), the eleventh tool, and URL wording in the instructions.
- `test/url.test.ts` — new: URL shapes, the host rule, line anchors, offline
  parsing.
- `test/search.test.ts` — the three output modes, the context hunk rules, and
  fixture branches `feat/CONTEXT` and `feat/MANY` (21 files).
- `test/store.test.ts` — blobless refusal and repair, and the UTF-8 cut end to end
  (fixture branch `feat/UTF8`).
- `test/git.test.ts`, `test/repos.test.ts`, `test/protocol.test.ts` — the decoder
  cases (including the invalid-tail rule), the unsupported-strategy cell, and
  `url` / `output: "count"` / `context: 1` over the real MCP surface.
- Suite: 169 tests / 31 suites at `v0.8.0` → **254 / 46**.
- Commits: `8552305` URLs and line ranges, `49a3517` `search` output modes,
  `5d19384` `search` context, `2458f11` the `cloneStrategy` refusal plus the
  truncation and stale-visibility review.
- Live check, after `opencode service restart`, against `example-app` @
  `fix/PROJ-7608` (`8297d0d`): `parse_gitlab_url` on a slashed-ref blob link
  with `#L118-126` → `ref_kind="branch" ref_confirmed="true"`; `get_file` by that
  URL → `file_lines="373"` and exactly lines 118–126; `search data-testid
  output="count"` → `count="100" total="682" files="269"`; `search context=2` →
  `>`-marked hunks and `…`; `list_tree` by a tree URL. Five failure shapes behaved
  as specified: a foreign host, `context` paired with `output: "files"`, a bad ref
  with five suggestions, an MR link, and a URL whose project disagreed with
  `project=`. Tagged `v0.9.0` on `54ff36e`; the milestone row is above.

### Phase 4a artifacts

- `docs/plan.md` §4 — the "Search" section written and reviewed **before** the
  code, including the mechanics below, and §7 split into 4a and 4b. The only plan
  correction afterwards was a wording one: the pathspec behaviour was described
  optimistically ("globs work") until measurement said `**` needs a level.
- `src/repoStore.ts` — `search` and `pickaxe`; `DEFAULT_MAX_MATCHES` (100),
  `HARD_MAX_MATCHES` (2000), `DEFAULT_PICKAXE_LIMIT` (20), a 5 MB stdout cap and
  a 500-character query cap; `validateQuery`; the two pure parsers
  `parseGrepMatches` (NUL split, first-newline cut, exact `sha:` prefix strip,
  torn records dropped) and `parsePickaxeEntries` (tabs, subject may contain
  them); `targetRef` (the `HEAD` default, displayed as the branch it names);
  `SearchResult.files`; and `resolveWithFreshness` now takes an optional
  pre-resolved source so an omitted ref does not resolve the source twice.
- `src/tools/search.ts` — new: the two tools, `formatSearch` (grouped by file,
  `count` / `total` / `files`, both truncation footers), `formatPickaxe`,
  `matchLine` (flatten, cut at 300 characters, report the characters cut), and
  the wording that carries the literal/case/pathspec decisions.
- `src/server.ts` — registers both, and the instructions now mention them.
- `test/search.test.ts` — new, 31 tests: the parsers against the real `-z`
  layout, and the fixture behaviour — a branch versus `main`, the `HEAD` default,
  grouping, case, literal versus ERE, pathspecs including `:(glob)`, a
  dash-leading query, the cap with its true total and file count, a missing ref
  with suggestions, fetch-on-miss via a branch published from elsewhere, and a
  registered clone answering a branch only its remote has.
- `test/protocol.test.ts` — exposure of both tools, and one end-to-end call each.
- Suite: 136 tests / 24 suites at `v0.7.0` → **169 / 31**.
- Measured against the pilot: grep ~100 ms, `pickaxe` 1.2–1.6 s (6189 commits),
  a read that fetches ~2.4 s, a miss that fetches ~2.0 s.

### Phase 2c-2 artifacts

- `src/sources.ts` — new. `SourceManager` takes the mechanics out of
  `RepoStore`: `mirrorPath`, `cloneMirror`, `fetch` (a mirror, or a clone by its
  detected remote name, through `--git-dir` plus `cwd`), `localSource` (a clone
  or a bare repo resolved to `{ gitDir, workDir, remote }`), `isRepo`,
  `remoteName`, `removeMirror` (refuses anything outside the cache's `mirrors/`),
  the `mcp-last-sync` clock, and the per-source lock. It holds no policy: when to
  fetch is decided in `RepoStore`, and only there. The move landed first and
  unchanged, so the feature was a readable diff.
- `src/registry.ts` — `set` (merges over the existing entry, so re-registering a
  path cannot reset a hand-written policy; `localPath: undefined` clears it) and
  `remove` (says whether there was anything to forget).
- `src/repoStore.ts` — `resolveSource` in place of `ensureMirror` (a local entry
  wins; otherwise clone-if-missing with the `manual` refusal), `sourceFor` /
  `sourcePresent`, `refresh(project, source, reason)` with the local rules (no
  TTL fetch, a miss fetches, `always` fetches, `manual` does nothing),
  `addRepo` / `removeRepo`, the clone ref view (`refCandidates`, `classifyRef`,
  `patternsFor`, `namedRef` over `refs/remotes/…`), and `listRepos` reporting a
  local row — `present`, `local_path`, an age from the clone's own stamp — and
  reading `present=false` instead of failing when the path is unusable.
- `src/tools/repos.ts` — `add_repo` and `remove_repo`, plus source-aware wording
  for `list_repos` and `sync_repo`.
- `src/tools/files.ts`, `src/tools/refs.ts`, `src/config.ts`, `src/server.ts` —
  wording only where "mirror" was not necessarily a mirror, and the two new tools
  in the server instructions.
- `test/local.test.ts` — new, 14 tests: a read served by the clone with no mirror
  created for it, an unpushed commit answering, a bare repository, `git status`
  byte-identical across reads, a branch only the remote has (invisible before,
  fetched on a miss, listed once as a branch), a clone with no remote, `ttl`
  versus `always` for a clone, the clone's own stamp, `add_repo` registering
  before a read and refusing a bad path, a vanished path, `remove_repo` sparing a
  clone and deleting a mirror, and the `removeMirror` guard.
- `test/fixture.ts` — `publishBranchFromElsewhere`: a branch committed in a
  throwaway clone of the fixture's "server", so `work` sees it only through a
  fetch — the state every real clone is in for the branches it has not checked
  out.
- `test/registry.test.ts`, `test/protocol.test.ts` — `set`/`remove`, and both
  tools as a client sees them. Suite: 136 tests / 24 suites (was 117 / 20).
- Live check: a clone of the pilot project made **from our own mirror**, so the
  check itself needed no network. Register, read (age `unknown`), delete one
  remote-tracking ref and watch the miss fetch it back, `sync_repo`, then
  `remove_repo` back onto the mirror. `git status` byte-identical throughout.
- No new dependency, no new environment variable, no new configuration key: a
  local clone is a registry entry, and `remove_repo` deletes only under
  `<cache>/mirrors`.

### Phase 2c-1 artifacts

- `src/registry.ts` — new: `parseRegistry` (validates the entries we understand,
  carries unknown keys through, and returns `undefined` for a file that is not
  ours so the caller decides), plus `RepoRegistry` — lazy single load, serialised
  writes through a temp file and a rename, and an `ensure` that never overwrites
  an existing entry. No timestamp field: the registry is policy only.
- `src/config.ts` — `FetchMode` gains `manual`, accepted in `GITLAB_FETCH_MODE`
  as the global default; the per-project override lives in the registry.
- `src/repoStore.ts` — `effectivePolicy`/`policyFor` (the single place a
  project's policy is resolved), a `manual` short-circuit in `refresh` returning
  `skipped: "manual"`, `ensureMirror` refusing to clone a manual project unless
  the caller passes `allowClone`, `syncRepo` in place of the removed
  `syncMirror`, `listRepos` reading each project's age from the stamp, and
  `registerMirror` (best effort — a registry that cannot be written must not fail
  a read). `notFoundRefMessage` now takes `{ refreshError, skipped }` and names
  `sync_repo` in manual mode.
- `src/tools/repos.ts` — new: `list_repos` (a row per project of `source=`,
  `freshness=`, `ttl=`, `present=`, `local_path=` and `synced_at=`) and
  `sync_repo`.
- `src/server.ts` — registers the two management tools and mentions them in the
  server instructions.
- `test/registry.test.ts` — new: parsing, persistence, ordering, never
  overwriting, the corrupt-file path and the zero-byte file.
- `test/repos.test.ts` — new: the listing renderer, including the unknown age.
- `test/store.test.ts` — a policy describe: registration on first use, manual
  refusing the clone, manual ignoring both `always` and a missing ref, the
  `always` override beating a 24-hour TTL, a stale list that cannot see a branch
  pushed a moment ago, and `present=false` for something registered but not on
  disk.
- `test/protocol.test.ts` — both tools as a client sees them. Suite: 117 tests /
  20 suites (was 93 / 16).
- No new dependency and no new environment variable. `repos.json` appears in the
  cache directory the first time a project is used.

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
