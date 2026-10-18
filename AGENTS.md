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
- Keep `docs/plan.md` — the canonical plan — updated as work lands.

## Reporting

When a step is done, state: what changed, what you verified, what you did **not**
do, and what you need next.
