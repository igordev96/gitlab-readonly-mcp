# gitlab-readonly-mcp

A small, read-only, **git-backed** MCP server for a self-managed GitLab.

It lets an AI agent read files from **any branch, tag, or commit** — including
branches that are not checked out locally — without ever touching your working
tree. Content is read from local bare mirrors that the server keeps in a cache
directory.

> Phase 2c-1 implementation. Exposes `get_file`, `list_tree`, `list_refs`,
> `resolve_ref`, plus `list_repos` and `sync_repo` for seeing and controlling
> what is registered. Backed by local bare mirrors that keep themselves fresh
> (TTL + fetch-on-miss), under a per-project policy that can turn that off.
> See the plan at [`docs/plan.md`](docs/plan.md) — the canonical, in-repo design
> document — and [`docs/history.md`](docs/history.md) for milestones, findings
> and per-phase artifacts.

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
`gitlab_resolve_ref`, `gitlab_list_repos` and `gitlab_sync_repo`.

## Usage

```
gitlab_list_repos()
gitlab_sync_repo(project="group/sub/repo")
gitlab_list_refs(project="group/sub/repo", kind="branches", search="PROJ")
gitlab_resolve_ref(project="group/sub/repo", ref="fix/PROJ-7608")
gitlab_list_tree(project="group/sub/repo", ref="fix/PROJ-7608", path="src")
gitlab_get_file(project="group/sub/repo", ref="fix/PROJ-7608", path="src/index.tsx")
```

Start with `list_refs` to find the branch and `resolve_ref` to confirm it, use
`list_tree` to see what is in it, then `get_file` to read a specific file. An
agent can do all four against a repository it has never cloned. `list_repos` and
`sync_repo` are the exception: they are about the server's own state rather than
about reading content.

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
local mirror was last refreshed — so the answer states how fresh it is instead
of quietly going stale.

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

## Repositories and policy

A project registers itself the first time it is used — its mirror is cloned on
demand — and the registry is a small `repos.json` in the cache directory:

```
<repos count="1">
group/sub/repo	source=mirror	freshness=ttl	ttl=600s	present=true	synced_at="2026-10-18T20:52:24.529Z"
</repos>
```

`synced_at` is when the mirror last fetched **successfully**, or `unknown` when
no fetch has ever stamped it; `present=false` means the project is registered but
its data is not on disk. `list_repos` costs no git call.

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

`sync_repo(project)` fetches immediately, ignoring the TTL. That is what makes
`manual` usable, and what to call when you want a fresh answer now. Unlike a
read, it reports a failure as an error instead of answering from the cache.

The registry deliberately records no fetch time: age comes from the mirror's own
stamp (`mcp-last-sync`), so there is one clock and it cannot disagree with
itself. A `repos.json` that does not parse is kept aside as
`repos.json.corrupt` rather than deleted.

## Freshness

Mirrors are cloned on first use and refreshed automatically, unless the policy is
`manual`:

- **TTL** — a read refreshes the mirror when it is older than
  `GITLAB_FETCH_TTL_SECONDS` (default 10 minutes).
- **Fetch-on-miss** — a ref that does not resolve locally triggers one extra
  fetch and retry, so a branch created moments ago is found without a manual
  sync. (If the read already fetched, no second fetch is attempted.)
- **`always`** — set `GITLAB_FETCH_MODE=always` to fetch before every read when
  correctness matters more than latency.
- **`manual`** — set `GITLAB_FETCH_MODE=manual`, or `freshnessMode: "manual"` for
  one project, and the server touches the network only when `sync_repo` asks it
  to: no TTL fetch, no fetch-on-miss, and not even the first-use clone. A project
  with no mirror yet is refused with a message naming `sync_repo`, and a ref that
  cannot be resolved says the same thing instead of implying that it does not
  exist.
- **Serialised** — fetches are serialised per project, so parallel tool calls
  never run overlapping fetches for the same repo.

One deliberate exception: **`list_refs` cannot use fetch-on-miss.** A ref that
does not resolve is a detectable miss, but a *stale list* is not — a branch
pushed a minute ago simply is not in the list, with nothing to signal that
anything is missing. So `list_refs` reports `synced_at` and leaves it at that.
`resolve_ref` is the way to check one specific ref, because it does refresh on a
miss.

Refresh timestamps are kept in memory and written to a stamp file inside the
mirror (`mcp-last-sync`), so they survive a server restart. The stamp is written
only after a fetch **succeeds** — git's own `FETCH_HEAD` is not used, because git
stamps it before a fetch fails, which would make a rejected fetch indistinguishable
from a fresh sync.

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
| `[refresh failed: …]` in a result | The mirror could not be refreshed, so the answer came from the cache as of `synced_at`. The note says why; the causes are the same as for a failed read. |

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
  store.test.ts         mirror resolution, guards, freshness, project policy
  registry.test.ts      the registry file: parsing, persistence, corruption
  refs.test.ts          ref listing, resolution, close matches
  tree.test.ts          directory listings, the ls-tree parser, rendering
  repos.test.ts         rendering the registry listing
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
- **Phase 2c-2 (next):** `add_repo`/`remove_repo`, and preferring a local clone
  over a mirror.
- **Phase 3:** `compare`, `diff_file`, `log`, `get_commit`, `blame`.
- **Phase 4:** `search` (`git grep`), `pickaxe`, GitLab URL parser, polish.
