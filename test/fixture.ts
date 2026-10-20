// Builds a small deterministic stand-in for GitLab, so tests never depend on
// network access, a token, or leftover on-disk state.
//
//   <root>/work      a normal checkout, where the "developer" commits
//   <root>/demo.git  a bare repo acting as the server; `work` pushes to it
//
// The server is deliberately named `demo.git` so that project `demo` resolves to
// `<host>/demo.git`, exactly the way the client builds GitLab URLs.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GIT = process.env.GIT_BIN ?? "git";

export interface Fixture {
  /** Directory containing everything; also the fixture's cache root. */
  root: string;
  /** A normal checkout. Tests make commits here. */
  work: string;
  /** Bare repository that plays the part of the GitLab server. */
  server: string;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync(GIT, ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function commit(cwd: string, message: string): void {
  execFileSync(
    GIT,
    [
      "-C",
      cwd,
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "-q",
      "-m",
      message,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function writeFile(root: string, relPath: string, contents: string): void {
  const target = path.join(root, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

/** Publish the current state of `work` to the bare "server" repository. */
function publish(work: string): void {
  // `--all` and `--tags` cannot be combined in a single invocation.
  runGit(work, ["push", "-q", "--force", "--all", "origin"]);
  runGit(work, ["push", "-q", "--force", "--tags", "origin"]);
}

/** Wipe `root` and rebuild the working repository and the server it pushes to. */
export function buildFixture(root: string): Fixture {
  fs.rmSync(root, { recursive: true, force: true });
  const work = path.join(root, "work");
  const server = path.join(root, "demo.git");
  fs.mkdirSync(path.join(work, "src"), { recursive: true });

  runGit(work, ["init", "-b", "main", "-q"]);
  writeFile(work, "src/index.tsx", "export const hello = 'main';\n");
  runGit(work, ["add", "-A"]);
  commit(work, "initial");

  runGit(work, ["checkout", "-q", "-b", "fix/TEST-1"]);
  writeFile(work, "src/index.tsx", "export const hello = 'fix/TEST-1';\n");
  writeFile(work, "docs/readme.md", "# demo\n");
  writeFile(work, "src/components/Button.tsx", "export const Button = () => null;\n");
  runGit(work, ["add", "-A"]);
  commit(work, "branch change");

  runGit(work, ["checkout", "-q", "main"]);

  // Annotated, so tests exercise tag peeling and not just lightweight refs.
  execFileSync(
    GIT,
    [
      "-C",
      work,
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "tag",
      "-a",
      "v1.0",
      "-m",
      "release 1.0",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

  // `-b main` so the server's HEAD names the branch it actually has; that is
  // what `default_branch` is read from, and a real GitLab repo does the same.
  execFileSync(GIT, ["init", "--bare", "--quiet", "-b", "main", server], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  runGit(work, ["remote", "add", "origin", server]);
  publish(work);

  // GitLab advertises `refs/merge-requests/*`, and a mirror clone copies every
  // ref. The fixture carries one so that "keep MR refs out of listings" is a
  // tested guarantee rather than an assumption.
  runGit(server, [
    "update-ref",
    "refs/merge-requests/1/head",
    runGit(work, ["rev-parse", "main"]).trim(),
  ]);

  return { root, work, server };
}

/** Create `branch` from main, add a file on it, commit, publish, return to main. */
export function addBranchWithFile(
  work: string,
  branch: string,
  relPath: string,
  contents: string,
  message: string,
): void {
  runGit(work, ["checkout", "-q", "main"]);
  runGit(work, ["checkout", "-q", "-b", branch]);
  writeFile(work, relPath, contents);
  runGit(work, ["add", "-A"]);
  commit(work, message);
  runGit(work, ["checkout", "-q", "main"]);
  publish(work);
}

/** Commit new contents on an existing branch, publish, then return to main. */
export function commitOnBranch(
  work: string,
  branch: string,
  relPath: string,
  contents: string,
  message: string,
): void {
  runGit(work, ["checkout", "-q", branch]);
  writeFile(work, relPath, contents);
  runGit(work, ["add", "-A"]);
  commit(work, message);
  runGit(work, ["checkout", "-q", "main"]);
  publish(work);
}

/**
 * Publish a branch the working checkout does not have, by committing it in a
 * throwaway clone of the server.
 *
 * That is the state a real clone is in for every branch but its own: the branch
 * exists only as `refs/remotes/<remote>/…`, where a bare name does not find it,
 * so reading it is what exercises fetch-on-miss. `work` is left untouched.
 */
export function publishBranchFromElsewhere(
  server: string,
  branch: string,
  relPath: string,
  contents: string,
): void {
  const elsewhere = path.join(path.dirname(server), "elsewhere");
  fs.rmSync(elsewhere, { recursive: true, force: true });
  execFileSync(GIT, ["clone", "-q", server, elsewhere], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  runGit(elsewhere, ["checkout", "-q", "-b", branch]);
  writeFile(elsewhere, relPath, contents);
  runGit(elsewhere, ["add", "-A"]);
  commit(elsewhere, "committed elsewhere");
  runGit(elsewhere, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
  fs.rmSync(elsewhere, { recursive: true, force: true });
}

/**
 * Rename `from` to `to` on `branch` (with new contents), commit and publish.
 *
 * `git mv` keeps the rename detectable only when the file is big enough to be
 * recognised, which is why the tests rename an eight-line file rather than a
 * one-line one.
 */
export function renameOnBranch(
  work: string,
  branch: string,
  from: string,
  to: string,
  contents: string,
  message: string,
): void {
  runGit(work, ["checkout", "-q", branch]);
  runGit(work, ["mv", from, to]);
  writeFile(work, to, contents);
  runGit(work, ["add", "-A"]);
  commit(work, message);
  runGit(work, ["checkout", "-q", "main"]);
  publish(work);
}

/**
 * Publish a branch with no parent at all, committing it as an orphan in the
 * working checkout and then restoring what was there.
 *
 * Two roots are what makes `git merge-base` answer nothing — exit 1 with no
 * output, measured — which is a comparison the tools have to name rather than
 * fail on.
 */
export function addOrphanBranch(
  work: string,
  branch: string,
  relPath: string,
  contents: string,
): void {
  runGit(work, ["checkout", "-q", "--orphan", branch]);
  runGit(work, ["rm", "-r", "-q", "-f", "."]);
  writeFile(work, relPath, contents);
  runGit(work, ["add", "-A"]);
  commit(work, "orphan root");
  runGit(work, ["checkout", "-q", "main"]);
  publish(work);
}

/**
 * Create `branch` from main, commit a file on it, then merge it back with
 * `--no-ff` and publish — so main carries a real merge commit, two parents and
 * no diff of its own.
 */
export function addMergedBranch(
  work: string,
  branch: string,
  relPath: string,
  contents: string,
  message: string,
): void {
  runGit(work, ["checkout", "-q", "main"]);
  runGit(work, ["checkout", "-q", "-b", branch]);
  writeFile(work, relPath, contents);
  runGit(work, ["add", "-A"]);
  commit(work, "branch work");
  runGit(work, ["checkout", "-q", "main"]);
  execFileSync(
    GIT,
    [
      "-C",
      work,
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "merge",
      "-q",
      "--no-ff",
      branch,
      "-m",
      message,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  publish(work);
}
