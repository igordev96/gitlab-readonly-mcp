# gitlab-readonly-mcp

A small, read-only, **git-backed** MCP server for a self-managed GitLab.

It lets an AI agent read files from **any branch, tag, or commit** — including
branches that are not checked out locally — without ever touching your working
tree. Content comes from a local bare mirror the server keeps in a cache
directory, or from a clone of your own when you register one.

> Phase 4a implementation. Exposes `get_file`, `list_tree`, `list_refs`,
> `resolve_ref`, `search` and `pickaxe`, plus `list_repos`, `add_repo`,
> `remove_repo` and `sync_repo` for choosing and controlling where a project is
> read from. A project is read from a bare mirror that keeps itself fresh
> (TTL + fetch-on-miss), or from a clone of your own, which is read in place and
> fetched only when a ref it does not have is asked for. See the plan at [`docs/plan.md`](docs/plan.md) — the canonical,
> in-repo design document — and [`docs/history.md`](docs/history.md) for
> milestones, findings and per-phase artifacts.

## Why git instead of the GitLab REST API?

The features that matter here — reading a file at a ref, comparing branches,
history and blame, and free code search (`git grep`) — are git's strengths and
the REST API's weaknesses on self-managed/free tiers.

## Requirements

- Node.js 20+ (developed on Node 24)
- `git` on `PATH`
- A GitLab token with the **`read_repository`** scope (a personal or project
  access token). Never use `api` or `write_repository`.

## Install

```powershell
npm install
npm run build
```

## Configuration

All configuration is via environment variables.

| Variable | Required | Description |
|---|---|---|
| `GITLAB_HOST` | yes | Base URL of the instance, e.g. `https://gitlab.example.com` (no trailing slash). |
| `GITLAB_TOKEN` | yes | Read-only token (`read_repository`). Injected per git call via `http.extraheader`; never written to `.git/config`. |
| `GITLAB_DEFAULT_PROJECT` | no | Project path used when a tool call omits `project`, e.g. `group/subgroup/repo`. |
| `GITLAB_MCP_CACHE` | no | Cache root for mirrors. Defaults to `%LOCALAPPDATA%\gitlab-readonly-mcp` (or `~/.cache/...` elsewhere). |
| `GITLAB_CA_INFO` | no | Path to a CA bundle, if the server uses a private CA. |
| `GITLAB_GIT_BIN` | no | Git executable. Defaults to `git`. |
| `GITLAB_FETCH_MODE` | no | Default freshness policy for every project: `ttl` (default) fetches only when a mirror is older than the TTL, `always` fetches before every read, `manual` never fetches by itself. A project can override it in `repos.json`. |
| `GITLAB_FETCH_TTL_SECONDS` | no | Age in seconds after which a mirror counts as stale. Default `600` (10 minutes). `0` behaves like `always`. |

These are the defaults; a project can override its freshness policy in
`repos.json` (see [Repositories and policy](#repositories-and-policy)).

## Wire into OpenCode

```powershell
opencode mcp add gitlab --global `
  --env GITLAB_HOST=https://gitlab.example.com `
  --env 'GITLAB_TOKEN={env:GITLAB_TOKEN}' `
  --env GITLAB_DEFAULT_PROJECT=group/subgroup/repo `
  -- node "C:\absolute\path\to\dist\index.js"
```

Or add it to configuration by hand (`mcp.servers`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "gitlab": {
        "type": "local",
        "command": ["node", "C:\\absolute\\path\\to\\dist\\index.js"],
        "environment": {
          "GITLAB_HOST": "https://gitlab.example.com",
          "GITLAB_TOKEN": "{env:GITLAB_TOKEN}",
          "GITLAB_DEFAULT_PROJECT": "group/subgroup/repo"
        }
      }
    }
  }
}
```

Use the **absolute** path to `dist/index.js`: a global MCP server's working
directory is the workspace it is launched from, not this project.

The tools appear as `gitlab_get_file`, `gitlab_list_tree`, `gitlab_list_refs`,
`gitlab_resolve_ref`, `gitlab_search`, `gitlab_pickaxe`, `gitlab_list_repos`,
`gitlab_add_repo`, `gitlab_remove_repo` and `gitlab_sync_repo`.

## Usage

```
gitlab_list_repos()
gitlab_add_repo(project="group/sub/repo", local_path="C:\\work\\repo")
gitlab_sync_repo(project="group/sub/repo")
gitlab_list_refs(project="group/sub/repo", kind="branches", search="PROJ")
gitlab_resolve_ref(project="group/sub/repo", ref="fix/PROJ-7608")
gitlab_list_tree(project="group/sub/repo", ref="fix/PROJ-7608", path="src")
gitlab_get_file(project="group/sub/repo", ref="fix/PROJ-7608", path="src/index.tsx")
gitlab_search(project="group/sub/repo", ref="fix/PROJ-7608", query="vehicleCount")
gitlab_pickaxe(project="group/sub/repo", ref="fix/PROJ-7608", query="vehicleCount")
gitlab_remove_repo(project="group/sub/repo")
```

Start with `list_refs` to find the branch and `resolve_ref` to confirm it, use
`list_tree` to see what is in it, then `get_file` to read a specific file. An
agent can do all four against a repository it has never cloned. `search` answers
"where is this used" when you do not know the file, and `pickaxe` answers "when
did it appear". `list_repos`, `add_repo`, `remove_repo` and `sync_repo` are the
exception: they are about the server's own state rather than about reading
content.

Results are wrapped so provenance is always visible:

```
<file project="group/sub/repo" ref="fix/PROJ-7608" commit="abc123…" path="src/index.tsx" synced_at="2026-10-18T09:12:44.318Z">
…file contents…
</file>
```

```
<refs project="group/sub/repo" kind="all" default_branch="develop" count="3" synced_at="2026-10-18T09:12:44.318Z">
branch  abc123def456  fix/PROJ-7608  PROJ-7608: adjust the header
branch  9f8e7d6c5b4a  develop           Merge branch 'release' into develop
tag     f1e2d3c4b5a6  v2.4.0            release 2.4.0
</refs>
```

`commit` is the exact commit the content came from, and `synced_at` is when the
source that answered — the mirror, or a registered clone — was last refreshed,
so the answer states how fresh it is instead of quietly going stale.

`list_tree` marks directories and reports each file's size in bytes, so you can
tell a small config from a bundle before reading it:

```
<tree project="group/sub/repo" ref="fix/PROJ-7608" commit="abc123…" path="src" count="3" synced_at="2026-10-18T09:12:44.318Z">
tree  -      src/components
blob  3047   src/index.tsx
blob  412    src/theme.css
</tree>
```

It lists one level deep by default; `recursive=true` walks the whole subtree
(files only), which is how you find a file whose directory you do not know. Paths
are relative to the repository root, so they can be handed straight to
`get_file`.

Missing refs and missing paths return a clean error instead of a git stack trace,
and a ref that does not exist suggests close matches:

```
Ref not found: "fix/PROJ-7609" in group/sub/repo. Did you mean:
  fix/PROJ-7608 (branch)
```

Binary files are refused. File output is capped (default 200 KB, override with
`max_bytes`); ref listings and tree listings are capped too (default 200, override
with `max_refs` and `max_entries` respectively) and say when they were cut short.

## Search

`search` greps the whole tree of a ref — `git grep`, not a checkout — and groups
the hits by file:

```
<search project="group/sub/repo" ref="fix/PROJ-7608" commit="abc123…" query="orderTotals" count="2" files="1" synced_at="2026-10-18T09:12:44.318Z">
src/reports/OrderTotals.tsx
  22: export const OrderTotalsReport = () => {
  64:   title={translations.reporting.seeOrderTotalsPage}
</search>
```

The ref defaults to the repository's default branch, so `search(query="…")` alone
reads what a fresh clone would show you. It is resolved before the grep runs,
which means a search gets the same freshness as a read — including fetch-on-miss,
so a branch created minutes ago is found without `sync_repo`.

Matching is **literal and case-insensitive**: `foo|bar` looks for that text, not
for `foo` or `bar`, because git's default pattern dialect treats `+`, `?` and `|`
as ordinary characters and a silent miss is worse than a visible extra match.
Pass `regex=true` for POSIX extended regex (not PCRE), and `case_sensitive=true`
for exact case. `path` is a git pathspec, so `src/components/*.tsx` narrows the
search; note that a plain pathspec's `**` needs at least one directory level —
use `:(glob)src/**/*.tsx` for zero or more.

Answers are capped (`max_matches`, default 100) and the true total is reported, so
a capped answer still tells you how big the thing is, and each long matched line
is cut with the number of characters left out.

`pickaxe` answers the follow-up — *when* did this text appear:

```
<pickaxe project="group/sub/repo" ref="fix/PROJ-7608" commit="abc123…" query="orderTotals" count="1" synced_at="2026-10-18T09:12:44.318Z">
8297d0da2	2026-10-15	Author	PROJ-7608: inconsistent productive vehicle count
</pickaxe>
```

It wraps `git log -S`, so it lists the commits whose diff changed **how often** the
text appears, most recent first, one row of `commit`, `date`, `author`, `subject`.
It walks the history of the ref and is therefore slower than `search` (seconds
rather than milliseconds on a large repository). Like `search` it matches
literally and case-insensitively; `case_sensitive=true` follows the text exactly,
and `limit` (default 20) caps the walk.

## Repositories and policy

A project registers itself the first time it is used — its mirror is cloned on
demand — or explicitly with `add_repo`. The registry is a small `repos.json` in
the cache directory:

```
<repos count="2">
group/sub/repo	source=mirror	freshness=ttl	ttl=600s	present=true	synced_at="2026-10-18T21:44:25.655Z"
group/sub/other	source=local	freshness=ttl	ttl=600s	present=true	local_path=C:\work\other	synced_at="unknown"
</repos>
```

`synced_at` is when **that source** last fetched successfully, or `unknown` when
no fetch has ever stamped it; `present=false` means the project is registered but
its data is not on disk — a mirror that was never cloned, or a registered clone
that has since been moved or deleted. The age shown belongs to the source that
answered, so a clone and its mirror each report their own.

### Reading from a clone of your own

```
gitlab_add_repo(project="group/sub/repo", local_path="C:\\work\\repo")
```

The path is checked there and then — it must exist and be a git repository, a
working clone or a bare one — so a typo fails at the call that records it rather
than at the read that would have used it. From then on every read runs against
that clone: nothing is cloned, and nothing is written to your working tree, so
uncommitted work is untouched. A branch that is not the checked-out one is still
found, through its remote-tracking ref, because that is where `git clone` keeps
every other branch. The remote is detected (`origin` when there is one), never
assumed, and a clone with no remote still reads everything it holds — a miss
there says so plainly instead of pretending the ref does not exist.

```
gitlab_add_repo(project="group/sub/repo")             # back to a mirror
gitlab_remove_repo(project="group/sub/repo")          # forget it entirely
gitlab_remove_repo(project="group/sub/repo", delete_mirror=True)
```

`remove_repo` never deletes a clone: that repository is yours, and the server
only ever deletes inside its own `mirrors/` directory. Forgetting a mirror-backed
project does not stick, because the next read registers it again; forgetting a
*local* registration does, and is how a project goes back to being read from a
mirror.

A project's policy can be overridden by hand (absent fields mean the configured
default):

```jsonc
{
  "version": 1,
  "repos": {
    "group/sub/repo": {
      "source": "mirror",          // "mirror" | "local"
      "localPath": null,           // set when source == "local"
      "cloneStrategy": "full",
      "freshnessMode": "manual",   // "ttl" | "always" | "manual"
      "freshnessTtlSeconds": 3600
    }
  }
}
```

`add_repo` merges into whatever is already recorded, so re-pointing a project at
a path cannot quietly reset a `freshnessMode` you set by hand.

`sync_repo(project)` fetches immediately, ignoring the TTL, and follows the
project's source — a mirror, or the clone's own remote. That is what makes
`manual` usable, and what to call when you want a fresh answer now. Unlike a
read, it reports a failure as an error instead of answering from the cache.

The registry deliberately records no fetch time: age comes from the source's own
stamp (`mcp-last-sync`, inside the mirror or inside the clone's `.git`), so there
is one clock per source and it cannot disagree with itself. A `repos.json` that
does not parse is kept aside as `repos.json.corrupt` rather than deleted.

## Freshness

Mirrors are cloned on first use and refreshed automatically, unless the policy is
`manual`:

- **TTL** — a read refreshes the mirror when it is older than
  `GITLAB_FETCH_TTL_SECONDS` (default 10 minutes). Never a registered clone: it
  is not a mirror of ours to keep fresh, and it is authoritative about the refs
  it holds.
- **Fetch-on-miss** — a ref that does not resolve locally triggers one extra
  fetch and retry, so a branch created moments ago is found without a manual
  sync. (If the read already fetched, no second fetch is attempted.) This is the
  one fetch a clone does get, and it goes to the clone's own remote.
- **`always`** — set `GITLAB_FETCH_MODE=always` to fetch before every read when
  correctness matters more than latency. The one mode that fetches a clone on a
  timer, because that is you asking.
- **`manual`** — set `GITLAB_FETCH_MODE=manual`, or `freshnessMode: "manual"` for
  one project, and the server touches the network only when `sync_repo` asks it
  to: no TTL fetch, no fetch-on-miss, and not even the first-use clone. A project
  with no mirror yet is refused with a message naming `sync_repo`, and a ref that
  cannot be resolved says the same thing instead of implying that it does not
  exist.
- **Serialised** — fetches are serialised per source, so parallel tool calls
  never run overlapping fetches for the same repo, and a clone and a mirror never
  wait on each other.

One deliberate exception: **`list_refs` cannot use fetch-on-miss.** A ref that
does not resolve is a detectable miss, but a *stale list* is not — a branch
pushed a minute ago simply is not in the list, with nothing to signal that
anything is missing. So `list_refs` reports `synced_at` and leaves it at that.
`resolve_ref` is the way to check one specific ref, because it does refresh on a
miss.

Refresh timestamps are kept in memory and written to a stamp file inside the
source's git directory (`mcp-last-sync`), so they survive a server restart. The
stamp is written only after a fetch **succeeds** — git's own `FETCH_HEAD` is not
used, because git stamps it before a fetch fails, which would make a rejected
fetch indistinguishable from a fresh sync. A registered clone keeps its own
stamp in its own `.git`, so a fetch there says nothing about the mirror.

**A refresh that fails does not fail the read.** When the mirror cannot be
reached, or the token is rejected, the cached mirror answers and the result says
so: `refresh_failed="true"` in the header and a `[refresh failed: …]` note
carrying the same diagnosis a failed read gives — the hint, and git's own words.
Beside it, `synced_at` names the last *successful* sync, or reads
`synced_at="unknown"` when no fetch has ever stamped that mirror, so an age that
was never measured is stated rather than left blank. The one thing it will not do
is present cached data as fresh. A ref that is missing *and* was looked for
through a failed refresh says so as well, because then a missing ref is not
evidence that it does not exist.

## Troubleshooting

A failed read explains itself: the cause, a hint when the failure is one we
recognise, and git's own output as evidence (`git said: …`). No extra logging is
needed to find out what happened.

| What you see | What it means |
|---|---|
| *GitLab rejected the credentials* | `GITLAB_TOKEN` is missing, expired, or lacks `read_repository` access to the project. GitLab reports a project you cannot *see* as a 401 too, so a typo in the project path looks identical. |
| *GitLab could not find this project* | Check the project path (`group/subgroup/repo`) and the token's access to it. |
| *TLS verification failed* | The server uses a private CA; point `GITLAB_CA_INFO` at the CA bundle. |
| *Could not reach GitLab* | Network or VPN. |
| `[refresh failed: …]` in a result | The source could not be refreshed, so the answer came from the cache as of `synced_at`. The note says why; the causes are the same as for a failed read. |
| *The registered clone at … is not a usable git repository* | The path recorded by `add_repo` has been moved, deleted or emptied. Run `add_repo` again with the current path, or `remove_repo` to go back to a mirror. |
| *The registered clone at … has no remote to fetch from* | The clone has no remote configured, so a ref it does not already hold cannot be fetched. Everything it does hold still reads. |
| `search` finds nothing, although you can see the text | Matching is literal and one argument: `foo\|bar` means that text, not `foo` or `bar` — pass `regex=true` for alternation. A `path` that matches nothing also returns no matches rather than an error, and a plain pathspec's `**` needs a directory level (`src/**/*.tsx` misses `src/index.tsx`; use `:(glob)src/**/*.tsx`). |
| `pickaxe` lists no commits for text you can see | It reports commits whose diff *changed how many times* the text appears (`git log -S`), so text unchanged since the root commit, or brought in by a merge git does not diff, has no commit to list. Matching is literal and case-insensitive; `case_sensitive=true` follows the case exactly. |

The credential case is worth one extra note: **a running MCP server keeps the
token it started with.** Editing `GITLAB_TOKEN` does nothing to a server that is
already running, which makes a valid token look broken. Restart the client (for
OpenCode, `opencode service restart`) after changing it.

The first read of a project also clones it, so it is slow exactly once.

## Security

- The token is only ever passed as `-c http.extraheader=…` on the git command
  line, so it never lands in `.git/config`.
- The token is redacted from error output before it reaches a tool result.
- `credential.helper=` is cleared and `GIT_TERMINAL_PROMPT=0` is set, so a bad
  token fails fast instead of prompting or hanging.
- Refs and paths beginning with `-` are rejected to prevent argument injection.
- Git is invoked with an argument array and `shell: false`.

## Development

```powershell
npm run typecheck   # src/ and test/
npm test            # builds, then runs the test suite
```

`npm test` rebuilds first (the compiled-entry-point test runs `dist/`), then runs
every `test/**/*.test.ts` through Node's built-in test runner via `tsx`. The
tests import `src/` directly, so there is no way to accidentally test a stale
build.

Tests wipe and rebuild a throwaway "GitLab" under the system temp directory — a
working repo plus a bare repo it pushes to — so they exercise real clone and
fetch behaviour, including freshness, without any network access or token. Each
test file gets its own fixture directory, so files can run in parallel.

### Versioning

The version the server reports comes from `package.json`, and the rule is that it
equals the newest tag. A release is made by hand — bump `package.json` and
`package-lock.json`, commit `chore(release): X.Y.Z`, then an annotated `vX.Y.Z`
tag — so the bump is a reviewable commit rather than a side effect. The compiled
server's reported version is asserted against `package.json` in the test suite.

```
src/                    server source
test/
  fixture.ts            builds the throwaway "GitLab"
  store.test.ts         source resolution, guards, freshness, project policy
  registry.test.ts      the registry file: parsing, persistence, corruption
  local.test.ts         local clones: reading, misses, path and delete guards
  refs.test.ts          ref listing, resolution, close matches
  tree.test.ts          directory listings, the ls-tree parser, rendering
  search.test.ts        grep and log -S: their parsers, rendering, fixture reads
  repos.test.ts         rendering the registry listing
  git.test.ts           the git wrapper
  gitDiagnostics.test.ts  git stderr → actionable hint
  protocol.test.ts      the MCP surface over an in-memory transport
  startup.test.ts       the compiled entry point over real stdio
tsconfig.json           typecheck: src/ + test/, no emit
tsconfig.build.json     emit: src/ only → dist/
```

## Roadmap

- **Phase 1 (done):** stdio server + `get_file`.
- **Phase 2a (done):** freshness — TTL, fetch-on-miss, per-project fetch lock,
  `synced_at` provenance, and a failed refresh that serves the cache and says so.
- **Phase 2b (done):** `list_refs`, `resolve_ref` (both with close-match hints)
  and `list_tree`.
- **Phase 2c-1 (done):** the project registry, `list_repos`, `sync_repo`,
  per-project policy and `manual` freshness mode.
- **Phase 2c-2 (done):** `add_repo`/`remove_repo`, and reading a project from a
  clone of your own — including the branches that only exist as remote-tracking
  refs there.
- **Phase 4a (done):** `search` (`git grep` over the tree of any ref) and
  `pickaxe` (`git log -S`: when the text appeared).
- **Phase 3 (next):** `compare`, `diff_file`, `log`, `get_commit`, `blame`.
- **Phase 4b:** GitLab URL parser, match context for `search`, `files`/`count`
  output modes, blobless clones, truncation and stale-visibility review.
