// Diagnostics are pure functions over git's stderr, so they are cheap to test.
// The samples below are real git output, copied from actual failures, so the
// patterns are checked against what git prints rather than against something
// invented to match them.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { GitError } from "../src/git.js";
import { explainGitError, hintForGitStderr } from "../src/gitDiagnostics.js";

const STDERR = {
  basicAuthDenied: [
    "remote: HTTP Basic: Access denied. The provided password or token is incorrect or your account has 2FA enabled and you must use a personal access token instead of a password.",
    "fatal: Authentication failed for 'https://gitlab.example.com/group/repo.git/'",
  ].join("\n"),
  promptsDisabled:
    "fatal: could not read Username for 'https://gitlab.example.com': terminal prompts disabled",
  tls: "fatal: unable to access 'https://gitlab.example.com/group/repo.git/': SSL certificate problem: unable to get local issuer certificate",
  network:
    "fatal: unable to access 'https://gitlab.example.com/group/repo.git/': Could not resolve host: gitlab.example.com",
  notFound:
    "fatal: repository 'file:///C:/tmp/nope/demo.git' does not appear to be a git repository",
  unknown: [
    "remote: something nobody has seen before",
    "fatal: and it is not one of our patterns",
  ].join("\n"),
};

function failedClone(stderr: string): GitError {
  return new GitError("Failed to clone demo.", 128, stderr);
}

describe("git failure hints", () => {
  it("recognises rejected credentials", () => {
    assert.match(hintForGitStderr(STDERR.basicAuthDenied) ?? "", /credentials/);
  });

  it("recognises prompts being disabled as the same credential problem", () => {
    assert.match(hintForGitStderr(STDERR.promptsDisabled) ?? "", /credentials/);
  });

  it("mentions restarting the client after a token change", () => {
    assert.match(hintForGitStderr(STDERR.basicAuthDenied) ?? "", /restart the MCP client/);
  });

  it("blames a private CA rather than the network for a TLS failure", () => {
    const hint = hintForGitStderr(STDERR.tls) ?? "";
    assert.match(hint, /GITLAB_CA_INFO/);
    assert.doesNotMatch(hint, /VPN/);
  });

  it("recognises an unreachable host", () => {
    assert.match(hintForGitStderr(STDERR.network) ?? "", /VPN/);
  });

  it("recognises a bad project path", () => {
    assert.match(hintForGitStderr(STDERR.notFound) ?? "", /project path/);
  });

  it("admits when it does not recognise the failure", () => {
    assert.equal(hintForGitStderr(STDERR.unknown), undefined);
  });
});

describe("explainGitError", () => {
  it("reports the cause and quotes git's own words", () => {
    const report = explainGitError(failedClone(STDERR.basicAuthDenied));
    assert.match(report, /Failed to clone demo\./);
    assert.match(report, /credentials/);
    assert.match(report, /git said: .*HTTP Basic: Access denied/);
  });

  it("still quotes git when no hint matches", () => {
    const report = explainGitError(failedClone(STDERR.unknown));
    assert.equal(report.split("\n")[0], "Failed to clone demo.");
    assert.match(report, /git said: .*something nobody has seen before/);
    assert.doesNotMatch(
      report,
      /credentials|VPN|GITLAB_CA_INFO|project path/,
      "an unrecognised failure must not be given a guess",
    );
  });

  it("omits the excerpt when git said nothing at all", () => {
    assert.equal(
      explainGitError(new GitError("Failed to clone demo.", null, "")),
      "Failed to clone demo.",
    );
  });

  it("truncates a wall of stderr", () => {
    const report = explainGitError(failedClone("x".repeat(2000)));
    assert.match(report, /\[… truncated\]/);
    assert.ok(report.length < 700, `report should stay readable, got ${report.length} chars`);
  });
});
