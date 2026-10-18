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
    ["-C", cwd, "-c", "user.email=test@example.com", "-c", "user.name=Test",
      "commit", "-q", "-m", message],
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
  runGit(work, ["add", "-A"]);
  commit(work, "branch change");

  runGit(work, ["checkout", "-q", "main"]);

  execFileSync(GIT, ["init", "--bare", "--quiet", server], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  runGit(work, ["remote", "add", "origin", server]);
  publish(work);

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
