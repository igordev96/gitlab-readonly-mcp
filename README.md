# gitlab-readonly-mcp

A small, read-only, **git-backed** MCP server for a self-managed GitLab.

It lets an AI agent read files from **any branch, tag, or commit** — including
branches that are not checked out locally — without ever touching your working
tree. Content is read from local bare mirrors that the server keeps in a cache
directory.

> Phase 1 implementation. Currently exposes a single tool: `get_file`.
> See the plan at `C:\Users\example\.opencode\plan\gitlab-mcp-plan.md`.

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

The tool appears as `gitlab_get_file`.

## Usage

```
gitlab_get_file(project="group/sub/repo", ref="fix/PROJ-7608", path="src/index.tsx")
```

Results are wrapped so provenance is always visible:

```
<file project="group/sub/repo" ref="fix/PROJ-7608" commit="abc123…" path="src/index.tsx">
…file contents…
</file>
```

Missing refs and missing paths return a clean error instead of a git stack trace.
Binary files are refused. Output is capped (default 200 KB, override with
`max_bytes`).

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
npm run typecheck
npm run build
npm run smoke     # runs against a fixture mirror; no network or token needed
```

## Roadmap

- **Phase 1 (done):** stdio server + `get_file`.
- **Phase 2:** repo registry (`add_repo`/`list_repos`/`sync_repo`), prefer local
  clones, `list_tree`, `list_refs`, `resolve_ref`, freshness policy (TTL +
  fetch-on-miss).
- **Phase 3:** `compare`, `diff_file`, `log`, `get_commit`, `blame`.
- **Phase 4:** `search` (`git grep`), `pickaxe`, GitLab URL parser, polish.
