# Security

This page is for the person deciding whether to hand this server a GitLab
token. It covers what the server can reach, where the token goes, what it
writes, and what it cannot protect you from. The last section names the tests
behind these claims.

## What runs

`gitlab-readonly-mcp` is a local process. Your MCP client (OpenCode, Cursor, or
any stdio client) starts it and talks to it over stdin and stdout. There is no
listening port and no hosted service.

It runs with your user account, so it can read whatever you can read. In
practice that is the cache directory, the clone you may register, and the token
you give it.

One process talks to one GitLab host, the one `GITLAB_HOST` names.

## The token

The token needs the `read_repository` scope. The server never calls the GitLab
REST API, so an `api` scope adds nothing it can use, and there is no code path
that pushes, so `write_repository` adds nothing either. The server cannot make
a token narrower than GitLab allows. A project access token with the Reporter
role, `read_repository`, and an expiry is the smallest thing that works.

You pass the token in the client's environment block. The server reads it once
at startup and keeps it in memory. A restarted server keeps the token it
started with, so after changing the token, restart the client.

Calls to GitLab carry the token as an `Authorization: Basic` header. The clone
URL is built as `${GITLAB_HOST}/${project}.git` with no credentials in it, and
the header is injected per call, so the token never reaches `.git/config`.
Anything git prints on failure passes through a redaction step that removes the
token before the text can appear in a tool result.

One detail is easy to miss. The header travels as a `-c http.extraheader=...`
argument, so during a git call the token sits in that child process's command
line. The git child also inherits the server's environment, which includes
`GITLAB_TOKEN`. Another process running as the same user can read either one
while the call runs. Nothing is persisted, so the window closes with the call.
On a single-user machine this is a small exposure; on a shared one it is worth
knowing before you install.

## What it writes

The cache directory (default `%LOCALAPPDATA%\gitlab-readonly-mcp`) holds:

- bare mirrors, which are full copies of each project you have read;
- `repos.json`, which records source and freshness policy only, with no token
  and no sync times;
- `mcp-last-sync` stamps inside each git directory.

A clone you register with `add_repo` is read through its `.git`. When a fetch
is due, git writes new objects, remote-tracking refs and the stamp there. The
working tree is left alone: nothing is checked out, stashed, reset or switched,
and a test compares `git status --porcelain` before and after every read.

The server's own messages go to stderr for the client to capture, and name
projects, not the token. There is no telemetry and no update check.

## What it connects to

Only `GITLAB_HOST`, over git's HTTP or HTTPS. `GITLAB_HOST` must start with
`http://` or `https://`, so the server never reaches a host by another
protocol.

A pasted GitLab URL is input like any other. Its host must equal `GITLAB_HOST`
or the call is refused, and the ref and path parsed from it go through the same
checks as direct arguments. Refs and paths beginning with `-` are rejected, and
git runs with an argument array and `shell: false`.

## Repository content is untrusted

Files, commit messages, branch names and diffs come back to the AI as plain
text. A repository can contain text written to steer a model, and the server
does not detect or remove it. The server has no write path of its own, but the
agent reading those files may have tools this server does not. Treat a file
from an unfamiliar branch the way you would treat a script from a stranger.

## What it does not do

No push. No merge requests, issues, pipelines or CI logs. No HTTP transport, so
no way to share one instance between users. No write tool of any kind, and no
auto-update.

## Residual risks

- The token is visible to processes running as the same user during a git call,
  as described above.
- The cache holds full copies of private source code. It is not encrypted, so
  protect it the way you protect a checkout.
- Repository content can carry instructions aimed at the AI, and the server
  does not filter them.
- A token with more than `read_repository` carries that extra reach wherever
  the token is used. The server will not exercise it, but it cannot take it
  away.

## Reporting a problem

Report a security problem privately if the repository offers it. GitHub's
Security tab has a "Report a vulnerability" form when private reporting is
enabled. If it is not, open an issue that describes the impact and leaves out a
working exploit.

Only the newest release is supported. This is a personal project with no
response-time promise.

## What is tested

- `test/git.test.ts` covers token redaction.
- `test/store.test.ts` covers the rejection of refs beginning with `-`.
- `test/local.test.ts` covers a registered clone staying byte-identical across
  reads.
- `test/url.test.ts` and `test/protocol.test.ts` cover the host rule for pasted
  links.

The rest of the suite covers the read surface. Live checks against a real
GitLab are recorded in [`docs/history.md`](docs/history.md).
