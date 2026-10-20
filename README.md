# gitlab-readonly-mcp

A small, read-only, **git-backed** MCP server for a self-managed GitLab.

It lets an AI agent read files from **any branch, tag, or commit** — including
branches that are not checked out locally — without ever touching your working
tree. Content comes from a local bare mirror the server keeps in a cache
directory, or from a clone of your own when you register one.

## Why git instead of the GitLab REST API?

Reading a file at a ref, comparing branches, history, blame and code search are
git's strengths and, on a self-managed free tier, the REST API's weaknesses.
[How it works](docs/internals.md) has the longer answer.

## Requirements

- Node.js 24+ (developed on Node 24.21)
- `git` on `PATH`
- A GitLab token with the **`read_repository`** scope (a personal or project
  access token). Never use `api` or `write_repository`.

## Install

Not published to npm (`private: true`). Build a tarball and install it
globally:

```powershell
npm install
npm pack --pack-destination .          # gitlab-readonly-mcp-0.10.0.tgz
npm install -g .\gitlab-readonly-mcp-0.10.0.tgz
```

That puts `gitlab-readonly-mcp` on `PATH`; it speaks MCP on stdio from any
directory. To upgrade, repeat after the version bump. To uninstall,
`npm rm -g gitlab-readonly-mcp`.

Under `nvm`, global packages live inside the active Node version, so switching
versions hides the command until you reinstall it.

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
  -- gitlab-readonly-mcp
```

Or add it to configuration by hand (`mcp.servers`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "gitlab": {
        "type": "local",
        "command": ["gitlab-readonly-mcp"],
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

The command is the installed binary, so the entry point no longer depends on
where the checkout lives — a global MCP server's working directory is the
workspace it is launched from, not this project. If the bare name does not
resolve on your machine, `npm prefix -g` gives the prefix; `<prefix>\gitlab-readonly-mcp.cmd`
is the same package by absolute path.

The tools appear as `gitlab_<tool>` — `gitlab_get_file`, `gitlab_log`, and so
on. All sixteen are listed below.

## What it can do

| Tool | What it answers |
|---|---|
| **Files and trees** | |
| `get_file` | One file at a ref — the whole file or a line range. Accepts a blob, raw or blame link. |
| `list_tree` | A directory at a ref, one level deep or recursive. Accepts a tree link. |
| **Refs** | |
| `list_refs` | Branches and tags, with the commit each points at. |
| `resolve_ref` | What a branch, tag or sha resolves to, with close matches when the name is wrong. |
| **Search** | |
| `search` | Grep a ref's tree, grouped by file — matched lines, file paths, or per-file counts. |
| `pickaxe` | The commits whose diff changed how often a text appears. |
| **History and diffs** | |
| `log` | A ref's history, optionally for one path. Accepts a history link. |
| `get_commit` | One commit: message, parents, author, files, line counts, and the patch on request. Accepts a commit link. |
| `blame` | Who last touched each line, grouped by commit. Accepts a blame link. |
| `compare` | What changed on one ref since it split from another, as a capped file summary. |
| `diff_file` | One file's patch between two refs. |
| **Links** | |
| `parse_gitlab_url` | What a GitLab link names — project, target, ref, path and line range — without reading anything. |
| **Repository policy** | |
| `list_repos` | Every project in use: its source, its policy and its true age. |
| `sync_repo` | Fetch now, ignoring the TTL. |
| `add_repo` | Read a project from a clone of your own instead of a mirror. |
| `remove_repo` | Forget a project. Never deletes your clone. |

## Quickstart

Examples use `group/sub/repo`; set `GITLAB_DEFAULT_PROJECT` to leave `project=`
out. Every result says which commit answered and how fresh it is — see
[What the odd bits mean](#what-the-odd-bits-mean).

**Read a file from a branch you have not checked out.** No clone of your own, no
checkout, no change to your working tree:

```
gitlab_get_file(project="group/sub/repo", ref="fix/PROJ-7608", path="src/index.tsx")
```

```
<file project="group/sub/repo" ref="fix/PROJ-7608" commit="abc123…" path="src/index.tsx" synced_at="2026-10-18T09:12:44.318Z">
…file contents…
</file>
```

**Browse a tree before reading.** Files carry their size, so a small config is
easy to tell from a bundle. `recursive=true` walks the whole subtree:

```
gitlab_list_tree(project="group/sub/repo", ref="fix/PROJ-7608", path="src")
```

```
<tree project="group/sub/repo" ref="fix/PROJ-7608" commit="abc123…" path="src" count="3" synced_at="…">
blob	3047	src/App.tsx
tree	-	src/components
blob	412	src/theme.css
</tree>
```

**Find and confirm a branch.** `list_refs` searches names; `resolve_ref` turns
one into a commit, and suggests close matches when the name is wrong:

```
gitlab_list_refs(project="group/sub/repo", kind="branches", search="PROJ")
```

```
<refs project="group/sub/repo" kind="branches" default_branch="develop" count="1" synced_at="…">
branch	abc123def456	fix/PROJ-7608	PROJ-7608: adjust the header
</refs>
```

**Find where something is used** — no clone, no knowledge of the file:

```
gitlab_search(project="group/sub/repo", ref="fix/PROJ-7608", query="orderTotals")
```

```
<search project="group/sub/repo" ref="fix/PROJ-7608" commit="abc123…" query="orderTotals" count="2" files="1" synced_at="…">
src/reports/OrderTotals.tsx
  22: export const OrderTotalsReport = () => {
  64:   title={translations.reporting.seeOrderTotalsPage}
</search>
```

`output="count"` answers "how many, in which files" without listing every match;
`context=2` adds the lines around each hit. `pickaxe(query=…)` answers the
follow-up: *when* did this text appear?

**Read a pasted link, including the lines it names.** A `#L118-126` anchor
becomes the range:

```
gitlab_get_file(url="https://gitlab.example.com/group/sub/repo/-/blob/fix/PROJ-7608/src/index.tsx#L118-126")
```

```
<file project="group/sub/repo" ref="fix/PROJ-7608" commit="abc123…" path="src/index.tsx" lines="118-126" file_lines="373" synced_at="…">
118: …
</file>
```

Each link kind has one reader: blob, raw and blame links go to `get_file` (or
`blame`), tree links to `list_tree`, `/-/commit/` to `get_commit`, `/-/commits/`
to `log`. A link handed to another tool is refused by name and says which tool
wants it. `parse_gitlab_url(url)` reports what a link names without reading
anything, and `resolve=false` does it offline.

**See the history, and who last touched a line.** `path` is optional and is a git
pathspec, so globs work:

```
gitlab_log(project="group/sub/repo", ref="fix/PROJ-7608", path="src/index.tsx")
```

```
<log project="group/sub/repo" ref="fix/PROJ-7608" commit="abc123…" path="src/index.tsx" count="2" synced_at="…">
abc123def4	2026-10-15T12:32:33+01:00	A. Author	PROJ-7608: adjust the header
def456abc7	2026-10-14T09:15:02+01:00	B. Author	Merge branch 'develop' into fix/PROJ-7608	(merge)
</log>
```

```
gitlab_blame(project="group/sub/repo", ref="fix/PROJ-7608", path="src/index.tsx", lines="118-126")
```

```
<blame project="group/sub/repo" ref="fix/PROJ-7608" commit="abc123…" path="src/index.tsx" lines="118-126" file_lines="373" groups="2" count="9" max_lines="500" synced_at="…">
def456abc789	B. Author	2026-04-23T10:11:50+02:00	118-121
  118: …
abc123def456	A. Author	2026-10-15T12:32:33+01:00	122-126
  122: …
</blame>
```

`get_commit(rev=…)` reads one commit — message, files, line counts, and the
patch with `patch=true`.

**Compare two branches.** `compare` prints the merge base it used, so which diff
ran is never hidden:

```
gitlab_compare(project="group/sub/repo", from="develop", to="fix/PROJ-7608")
```

```
<compare project="group/sub/repo" from="develop" to="fix/PROJ-7608" from_commit="…" to_commit="…" merge_base="def456abc789…" files="1" total_files="1" additions="32" deletions="11" max_files="100" synced_at="…">
M	src/index.tsx	+32 -11
</compare>
```

`diff_file(from=…, to=…, path=…)` is one file's patch; pass the `merge_base` it
printed as `from` for the branch's own view of the file.

## Gotchas

- `search` and `pickaxe` match **literally and case-insensitively**: `foo|bar`
  looks for that text. Pass `regex=true` for alternation, `case_sensitive=true`
  for exact case.
- A plain pathspec's `**` needs a directory level — `src/**/*.tsx` misses
  `src/index.tsx`. Use `:(glob)src/**/*.tsx` for zero or more.
- Omit `ref` to read the default branch, which is what a fresh clone shows you.
- `#L12` and `#L12-20` anchors are 1-based and inclusive.
- `compare` is three-dot by default; `merge_base=false` asks for the raw two-dot
  diff.
- Binary files are refused where the answer would be meaningless (a read, a
  blame); a diff gives git's `Binary files … differ` line instead of a patch.
- Caps are always reported: `truncated="true"`, `total=…` and `[cut: …]` say
  when an answer was shortened, rather than quietly returning less.

## What the odd bits mean

| You see | It means |
|---|---|
| `synced_at="…"` | When the source that answered last fetched successfully. `unknown` means no successful fetch has ever stamped it. |
| `refresh_failed="true"` | A refresh was due and failed, so the answer came from the cache; a `[refresh failed: …]` note says why. |
| `truncated="true"` / `total=…` | The answer was capped. Where the tool can count it, `total` is the real number before the cap. |
| `ref_confirmed="false"` | `parse_gitlab_url` could not match the link's ref against the project's refs — it is offline, or the link names a sha. `commit="…"` is the resolved revision when the link names one. |
| `merge_base="none"` | The two refs share no history, so `compare` ran the raw two-dot diff and said so. |
| `(no matches)` | Nothing matched. That is an answer, not an error. |

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
its data is not on disk — a mirror never cloned, or a clone since moved. A
project's policy can be overridden by hand (absent fields mean the configured
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

`add_repo` merges into what is already recorded, so re-pointing a project cannot
reset a `freshnessMode` you set by hand. `sync_repo(project)` fetches immediately
and follows the project's source (a mirror, or the clone's own remote) — that is
what makes `manual` usable, and what to call when you want a fresh answer now.
Unlike a read, `sync_repo` reports a failure as an error rather than answering
from the cache.

## Reading from a clone of your own

```
gitlab_add_repo(project="group/sub/repo", local_path="C:\\work\\repo")
```

The path is checked there and then — it must exist and be a git repository,
working clone or bare — so a typo fails at the call that records it. From then on
every read runs against that clone: nothing is cloned, and nothing is written to
your working tree, so uncommitted work is untouched. A branch that is not the
checked-out one is still found through its remote-tracking ref, because that is
where `git clone` keeps every other branch. A clone with no remote still reads
everything it holds; a miss says so plainly instead of pretending the ref does
not exist.

```
gitlab_add_repo(project="group/sub/repo")             # back to a mirror
gitlab_remove_repo(project="group/sub/repo")          # forget it entirely
gitlab_remove_repo(project="group/sub/repo", delete_mirror=True)
```

`remove_repo` never deletes a clone: that repository is yours, and the server
only ever deletes inside its own `mirrors/` directory. Forgetting a
mirror-backed project does not stick, because the next read registers it again;
forgetting a *local* registration does, and is how a project goes back to being
read from a mirror.

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
| `search` finds nothing, although you can see the text | Matching is literal and one argument: `foo\|bar` means that text, not `foo` or `bar` — pass `regex=true` for alternation. A plain pathspec's `**` needs a directory level (`src/**/*.tsx` misses `src/index.tsx`; use `:(glob)src/**/*.tsx`). |
| `pickaxe` lists no commits for text you can see | It reports commits whose diff *changed how many times* the text appears (`git log -S`), so text unchanged since the root commit, or brought in by a merge git does not diff, has no commit to list. Matching is literal and case-insensitive; `case_sensitive=true` follows the case exactly. |
| A link is refused: `URL host "…" does not match GITLAB_HOST ("…")` | The link belongs to another GitLab instance. Use a link from the instance `GITLAB_HOST` names; the server will not read a same-named project from elsewhere. |
| A link is refused: *is a file link; use get_file for it* (or *directory*, *commit*, *history*) | The link went to a tool that does not read it. Each kind has one reader: blob/raw/blame → `get_file` (or `blame`), tree → `list_tree`, `/-/commit/` → `get_commit`, `/-/commits/` → `log`. `parse_gitlab_url` says what a link names if it is unclear. |
| A link is refused: *is a merge request link* | Merge requests, issues and other non-code links name no version-control object, so they are refused by name. Take the ref and path from the page and call the tool directly. |
| A `context` call is refused | It needs `output="matches"`; `files` and `count` have no matched line to put context around. |
| `list_repos` prints `clone_strategy=blobless(unsupported)` | A `repos.json` entry asks for a clone strategy this server does not implement, so every read of that project fails with the value named. Set `"cloneStrategy": "full"` if the data on disk is a full clone, or `remove_repo` it with `deleteMirror=true` and use the project again, which clones it in full. |

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

## Read more

- [How it works](docs/internals.md) — where content comes from, freshness, and
  the read-only guarantee.
- [Development](docs/development.md) — build, test, releasing and the source
  layout.
- [Plan](docs/plan.md) — the design decisions and what is next.
- [History](docs/history.md) — milestones, findings, and the evidence from live
  checks.
