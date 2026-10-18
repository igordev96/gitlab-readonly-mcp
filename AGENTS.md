# Agent Instructions

This project is owned by igordev96. Be a collaborator, not an autopilot.

## Ask before acting

Stop and ask for explicit approval before any of these. Describe the change,
then wait for a yes.

- Creating or deleting files outside this project directory.
- Editing anything under `~/.config/opencode` or any other global/user config.
- Setting environment variables or writing to the Windows registry.
- Installing, upgrading, or removing dependencies.
- `git init`, committing, tagging, pushing, or changing remotes.
- Destructive git (`reset --hard`, `clean`, `checkout -f`, `branch -D`).
- Deleting or overwriting files not created in this session.
- Adding or removing MCP servers, plugins, or skills.

## Work in checkpoints

Prefer small, reviewable steps over large batches. After each step, report what
changed and ask before starting the next. Do not chain unrelated changes.

## Scope

- Stay inside this project unless told otherwise.
- Read-only commands (reading files, `git status`/`log`/`diff`) need no approval.
- Never print a secret. Never write a token into a tracked file.

## Project conventions

- Conventional Commits; LF line endings (see `.gitattributes`).
- Run `npm run typecheck && npm test` before committing (`npm test` builds first).
- Keep `docs/plan.md` — the canonical plan — updated as work lands, and record
  findings, milestones and per-phase artifacts in `docs/history.md`. The plan
  describes what will be and what is; history accumulates what happened. Keep
  the two apart, or the plan becomes a changelog.
- The version the server reports is read from `package.json`; keep it equal to
  the newest tag. `npm version <minor|patch>` bumps both in one step. That
  command commits and tags, so it still needs approval first.

## Verifying a phase

Fixtures catch what they can test; the live server catches the rest. Every phase
so far has found something the fixture could not, so end each phase with a manual
check against the real project, and make it a real check rather than a nice note:

1. **Say what to restart first.** The running MCP server keeps the code and the
   token it started with, so `opencode service restart` is required before a new
   tool or config is visible. The assistant's own tool list is a live probe of
   the running server — if a new tool is absent there, the restart has not
   happened.
2. **Give the exact calls**, with the real project path and ref, copy-pasteable,
   and state what success looks like *and* what failure looks like. A check that
   only confirms the happy path is a demo, not a test.
3. **Run them when the tools allow it, and report the real output** rather than
   describing what it would probably say. Prefer this to handing over a script.
4. **Record the outcome** in `docs/history.md`: the Milestones `verified live`
   column, and a findings row for anything learned. A phase whose live check has
   not happened is marked unverified — never ticked on the strength of a passing
   fixture.

## Reporting

When a step is done, state: what changed, what you verified, what you did **not**
do, and what you need next.
