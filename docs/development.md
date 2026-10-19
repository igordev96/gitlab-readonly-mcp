# Development

Working on the server itself: building it, testing it, and releasing it. The
rules for *how* work is done — checkpoints, approvals, the live check at the end
of a phase — are in [`AGENTS.md`](../AGENTS.md).

## Build and test

```powershell
npm run typecheck   # src/ and test/, no emit
npm test            # builds, then runs the whole suite
npm run build       # tsc -> dist/
npm run dev         # run src/ directly through tsx
npm start           # run the built dist/
```

`npm test` rebuilds first, because one test runs the compiled entry point in
`dist/` over real stdio; every other test imports `src/` through `tsx`. That
split is deliberate: a stale build cannot hide a failure, and the fast tests
cannot accidentally exercise old code.

## The test fixture

Tests never touch the network or need a token. `test/fixture.ts` builds a
throwaway "GitLab" under the system temp directory — a working repository plus a
bare repository it pushes to — so real clone and fetch behaviour is exercised,
including freshness. Each test file gets its own fixture directory, so files run
in parallel.

Anything that cannot be expressed in the fixture is either unit-tested against
parsed output or listed as a known gap in [`history.md`](history.md); the live
check against the real GitLab is what covers the rest.

## Versioning

The version the server reports comes from `package.json`, and the rule is that it
equals the newest tag. `startup.test.ts` asserts that the compiled entry point
reports exactly the `package.json` version, so a half-finished bump fails the
suite.

Releases are made by hand, so the bump is a reviewable commit rather than a side
effect:

```powershell
npm version minor --no-git-tag-version   # bumps package.json and both lock fields
git add package.json package-lock.json   # the flag stops npm from committing or tagging
git commit -m "chore(release): X.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z — <phase>"
```

There are no `preversion` / `version` / `postversion` scripts, so nothing commits,
tags or pushes behind your back. The milestone row in `history.md` is written
*after* the tag exists, because a commit cannot reference its own tag.

## Adding a tool

The mechanical path; the process rules are in `AGENTS.md`.

1. Design it in `plan.md` §4 first — what it answers, its arguments, its caps and
   its failure shapes.
2. Put the reading and parsing in `repoStore.ts`, returning a typed result.
3. Add the tool and its formatting to the right `src/tools/*.ts`, with a
   description that says how to read the result — the descriptions are the
   agent's manual, so they carry the semantics.
4. Register it in `server.ts` and extend the agent instructions there.
5. Test the store, the parser and the rendering in the matching
   `test/*.test.ts`, and the tool itself over the MCP surface in
   `protocol.test.ts`.
6. `npm run typecheck && npm test`.
7. Live check, then documentation: `README.md` (capability table + a quickstart
   example), `plan.md` (status) and `history.md` (artifacts and findings).

## Source layout

```
src/
  index.ts            stdio bootstrap: config, store, server
  server.ts           McpServer, tool registration, agent instructions
  config.ts           env parsing, host, cache dir, fetch policy
  git.ts              safe git exec: argument array, no shell
  gitDiagnostics.ts   git stderr -> classified, actionable hint
  repoStore.ts        the read API: refs, trees, files, search, history, diffs
  sources.ts          mirror/clone resolution, fetch, per-source lock and stamp
  registry.ts         repos.json: source, policy, clone strategy per project
  url.ts              GitLab web URL -> project, target, ref, path, line range
  tools/
    result.ts         shared result shapes and error rendering
    files.ts          get_file, list_tree
    refs.ts           list_refs, resolve_ref
    search.ts         search, pickaxe
    history.ts        log, get_commit, blame, compare, diff_file
    url.ts            parse_gitlab_url, link routing
    repos.ts          list_repos, sync_repo, add_repo, remove_repo
test/
  fixture.ts          builds the throwaway "GitLab"
  store.test.ts       source resolution, guards, freshness, project policy
  registry.test.ts    the registry file: parsing, persistence, corruption
  local.test.ts       local clones: reading, misses, path and delete guards
  refs.test.ts        ref listing, resolution, close matches
  tree.test.ts        directory listings, the ls-tree parser, rendering
  search.test.ts      grep and log -S: parsers, rendering, fixture reads
  history.test.ts     log, get_commit, blame, compare, diff_file
  url.test.ts         GitLab URL shapes, ref resolution, line anchors, routing
  repos.test.ts       rendering the registry listing
  git.test.ts         the git wrapper
  gitDiagnostics.test.ts  git stderr -> actionable hint
  protocol.test.ts    the MCP surface over an in-memory transport
  startup.test.ts     the compiled entry point over real stdio
tsconfig.json         typecheck: src/ + test/, no emit
tsconfig.build.json   emit: src/ only -> dist/
```

`src/repoStore.ts` is large because it holds every read operation and the parsers
that turn git's output into results. Splitting it by concern is a known piece of
future work, recorded in the plan rather than done as a side effect of another
change.
