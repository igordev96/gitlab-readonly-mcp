// Turns git's stderr into something a person (or an agent) can act on.
//
// git's own messages are accurate but scattered across several domains, and the
// same symptom ("clone failed") has very different causes: a revoked token, a
// missing VPN, a private CA, or a typo in the project path. Without the raw
// stderr and a hint, the only honest report is "it failed", which is useless.
import { GitError } from "./git.js";

/** Longest stderr excerpt included in a report. */
const MAX_EXCERPT = 500;

/**
 * Patterns are ordered by specificity. TLS is checked before network because
 * certificate failures also contain "unable to access", and authentication is
 * checked first because GitLab reports an inaccessible project as a 401.
 */
const AUTH =
  /(authentication failed|http basic: access denied|invalid credentials|could not read username|terminal prompts disabled|401 unauthorized|403 forbidden)/i;
const NOT_FOUND =
  /(repository not found|project you were looking for could not be found|remote: not found|does not appear to be a git repository)/i;
const TLS =
  /(ssl certificate problem|self-signed certificate|unable to get local issuer certificate|certificate verify failed|schannel)/i;
const NETWORK =
  /(could not resolve host|failed to connect|connection refused|connection timed out|operation timed out|network is unreachable|unable to access)/i;

const AUTH_HINT =
  "GitLab rejected the credentials. The token may be missing, expired, or lack " +
  "`read_repository` access to this project. Note that GitLab also reports a " +
  "project you cannot see as a 401, so a wrong project path looks the same. " +
  "After changing the token, restart the MCP client so the server inherits it.";

const NOT_FOUND_HINT =
  "GitLab could not find this project. Check the project path " +
  "(group/subgroup/repo) and the token's access to it.";

const TLS_HINT =
  "TLS verification failed. If GitLab uses a private CA, point GITLAB_CA_INFO " +
  "at the CA bundle.";

const NETWORK_HINT = "Could not reach GitLab. Check network and VPN access to the host.";

/** Identify a known failure mode from git's stderr, if we recognise it. */
export function hintForGitStderr(stderr: string): string | undefined {
  if (AUTH.test(stderr)) {
    return AUTH_HINT;
  }
  if (NOT_FOUND.test(stderr)) {
    return NOT_FOUND_HINT;
  }
  if (TLS.test(stderr)) {
    return TLS_HINT;
  }
  if (NETWORK.test(stderr)) {
    return NETWORK_HINT;
  }
  return undefined;
}

function excerptOf(stderr: string): string | undefined {
  const text = stderr.trim();
  if (!text) {
    return undefined;
  }
  if (text.length <= MAX_EXCERPT) {
    return text;
  }
  return `${text.slice(0, MAX_EXCERPT)} [… truncated]`;
}

/**
 * Compose a human-facing report for a failed git operation: what we tried, what
 * it probably means, and git's own words as evidence.
 *
 * The stderr is expected to be pre-redacted (see `Git.redact`).
 */
export function explainGitError(error: GitError): string {
  const lines = [error.message];

  const hint = hintForGitStderr(error.stderr);
  if (hint) {
    lines.push(hint);
  }

  const excerpt = excerptOf(error.stderr);
  if (excerpt) {
    lines.push(`git said: ${excerpt}`);
  }

  return lines.join("\n");
}
