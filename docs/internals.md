# How it works

What this server does under the hood: where content comes from, how fresh it is,
and why it cannot change anything. The *decisions* behind these rules — what was
measured, what was rejected — are in [`plan.md`](plan.md) §4; the evidence from
running it is in [`history.md`](history.md).

## Why git, not the GitLab REST API

The questions this server answers — read a file at a ref, compare two branches,
history, blame, search a whole tree — are git's strengths. On a GitLab
instance without Advanced Search (Free, self-managed or gitlab.com), several of
them are the REST API's weaknesses: advanced code search is not available,
blame and compare are per-resource round trips, and a big diff is a large JSON
document to paginate. Git already has exact
objects for every ref, a fast local search, and no pagination.

So the server fetches with git and answers from git. One `git clone --mirror`
per project is enough to serve every ref, every file and every diff; after that,
reads are local file and object access. The same token is used for the fetch and
for nothing else.

The second reason is the read-only guarantee: the commands this server runs are
`clone` and `fetch`, plus the read commands `show`, `ls-tree`, `grep`, `log`,
`diff`, `blame`, `rev-parse`, `merge-base`, `cat-file`, `for-each-ref` and
`symbolic-ref`. None of them writes to a repository, so a read cannot
disturb a working tree — and there is no write path to get wrong.

## Where content comes from

A project is read from one of two sources.

**A mirror** — `<cache>/mirrors/<project path>/<last segment>.git`, cloned with
`git clone --mirror` the first time the project is used. The cache defaults to
`%LOCALAPPDATA%\gitlab-readonly-mcp` (`XDG_CACHE_HOME`, then `~/.cache`, on other
platforms) and can be moved with `GITLAB_MCP_CACHE`. Mirrors are the server's own
data: it creates them, refreshes them, and is the only thing that ever deletes
them.

**A clone of your own** — registered with `add_repo(project, local_path)`, which
checks there and then that the path exists and is a git repository, so a typo
fails at the call that records it. From then on, every read runs against that
clone: nothing is cloned, nothing is written, uncommitted work is untouched. A
branch that is not checked out is still readable through its remote-tracking ref
(`refs/remotes/origin/…`), because that is where `git clone` keeps every other
branch. The remote is detected rather than assumed (`origin` when present), and
a clone with no remote still answers for everything it holds — a miss there says
so plainly instead of claiming the ref does not exist.

The delete guard lives in the cache: `remove_repo(delete_mirror=…)` only ever
removes a path that resolves inside `<cache>/mirrors`. A registered clone is
never deleted, whatever the call asks for.

## Freshness

Every source has one clock: a stamp file, `mcp-last-sync`, inside the source's
git directory (inside the mirror, or inside the clone's `.git`). It holds the
time of the last **successful** fetch. The registry deliberately records no
fetch time, so a source's age cannot disagree with itself, and a clone's fetch
says nothing about the mirror's.

The policy has three modes, from `GITLAB_FETCH_MODE` or per project in
`repos.json`:

- **`ttl`** (default) — a read refreshes a *mirror* when it is older than
  `GITLAB_FETCH_TTL_SECONDS` (default 600). A registered clone is never fetched
  on a timer: it is not ours to keep fresh, and it is authoritative about the
  refs it holds.
- **`always`** — fetch before every read. The one mode that fetches a clone on a
  timer, because that is the operator asking for it.
- **`manual`** — no network at all unless `sync_repo` asks: no TTL fetch, no
  fetch-on-miss, and not even the first-use clone. A project with no mirror yet
  is refused with a message naming `sync_repo`, and a ref that cannot be
  resolved says the same thing rather than implying it does not exist.

Independently of the mode, **fetch-on-miss** covers the one case the TTL cannot:
a ref that does not resolve locally triggers one extra fetch and a retry, so a
branch created moments ago is found without a manual sync. A clone gets this one
fetch too, from its own remote. If the read already fetched, no second fetch is
attempted.

**`list_refs` is the exception**: it cannot use fetch-on-miss. A ref that does
not resolve is a detectable miss; a *stale list* is not — a branch pushed a
minute ago is simply absent, with nothing to signal that anything is missing. So
`list_refs` reports `synced_at` and leaves it at that; `resolve_ref` is the way to
check one specific ref, because it does refresh on a miss.

Fetches are serialised **per source**, so parallel tool calls never overlap on
the same repository, and a clone and a mirror never wait on each other.

The stamp is written only after a fetch succeeds. Git's own `FETCH_HEAD` is not
used, because git writes it before a fetch fails, which would make a rejected
fetch indistinguishable from a fresh sync.

## When a refresh fails

A failed refresh does not fail the read. The cached mirror answers, and the
result says so: `refresh_failed="true"` in the header and a `[refresh failed: …]`
note carrying the same diagnosis a failed read would give — the classified hint
and git's own words. Beside it, `synced_at` names the last *successful* sync, or
`unknown` when no fetch has ever stamped that source, so an unmeasured age is
stated rather than left blank.

The one thing a failed refresh will not do is present cached data as fresh. And
a ref that is missing *and* was looked for through a failed refresh says so too,
because then "not found" is not evidence that the ref does not exist.

## The read-only guarantee

- The token is passed per git invocation as a configuration override —
  `-c http.extraheader=…` — so it never lands in `.git/config` or on disk in the
  repository.
- It is redacted from git's stderr before any of it reaches a tool result.
- `credential.helper=` is cleared and `GIT_TERMINAL_PROMPT=0` is set, so a bad
  token fails fast instead of prompting or hanging.
- Refs and paths beginning with `-` are rejected, so a value cannot become a git
  option; git is invoked with an argument array and `shell: false`, so no shell
  is involved and nothing needs quoting.
- No command that writes is ever run: no checkout, no reset, no commit, no
  update-ref. A registered clone is opened for reading only.

A repository registered with `cloneStrategy: "blobless"` is parsed and kept as
written, never silently downgraded: the server does not support it, and a read
refuses it by name so the registry and the behaviour cannot disagree.
