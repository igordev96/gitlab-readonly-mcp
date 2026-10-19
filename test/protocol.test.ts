// The MCP surface as a client sees it, over an in-memory transport.
// Runs entirely offline against a fixture "GitLab" built in the temp directory.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { Config } from "../src/config.js";
import { Git } from "../src/git.js";
import { RepoStore } from "../src/repoStore.js";
import { createServer } from "../src/server.js";
import { buildFixture } from "./fixture.js";

const fixture = buildFixture(path.join(os.tmpdir(), "glmcp-fixture-protocol"));

const config: Config = {
  host: pathToFileURL(fixture.root).href,
  token: "",
  cacheDir: path.join(fixture.root, "cache"),
  gitBin: "git",
  fetchMode: "ttl",
  fetchTtlSeconds: 600,
};

/** Just enough of the SDK's result shape to read the text out of it. */
interface TextResult {
  content: Array<{ text?: string }>;
  isError?: boolean;
}

function textOf(result: unknown): string {
  const { content } = result as TextResult;
  return content.map((part) => part.text ?? "").join("\n");
}

let client: Client;

describe("MCP protocol", () => {
  before(async () => {
    const store = new RepoStore(config, new Git({ bin: "git" }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(config, store);
    await server.connect(serverTransport);

    client = new Client({ name: "protocol-test", version: "0.0.0" });
    await client.connect(clientTransport);

    return async () => {
      await client.close();
      await server.close();
    };
  });

  after(async () => {
    await client?.close();
  });

  it("exposes get_file and list_tree", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of ["get_file", "list_tree"]) {
      assert.ok(names.includes(expected), `${expected} is missing; saw ${names.join(", ")}`);
    }
  });

  it("exposes list_refs and resolve_ref", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of ["list_refs", "resolve_ref"]) {
      assert.ok(names.includes(expected), `${expected} is missing; saw ${names.join(", ")}`);
    }
  });

  it("exposes list_repos and sync_repo", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of ["list_repos", "sync_repo"]) {
      assert.ok(names.includes(expected), `${expected} is missing; saw ${names.join(", ")}`);
    }
  });

  it("exposes search and pickaxe", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of ["search", "pickaxe"]) {
      assert.ok(names.includes(expected), `${expected} is missing; saw ${names.join(", ")}`);
    }
  });

  it("searches a tree at a ref, and follows a string through history", async () => {
    const found = await client.callTool({
      name: "search",
      arguments: { project: "demo", ref: "fix/TEST-1", query: "export const" },
    });
    assert.equal(found.isError, undefined);
    assert.match(
      textOf(found),
      /<search project="demo" ref="fix\/TEST-1" commit="[0-9a-f]{40}" query="export const" count="2" files="2"/,
    );
    assert.match(textOf(found), /src\/components\/Button\.tsx/);

    const counted = await client.callTool({
      name: "search",
      arguments: { project: "demo", ref: "fix/TEST-1", query: "export const", output: "count" },
    });
    assert.equal(counted.isError, undefined);
    assert.match(textOf(counted), /output="count" count="2" files="2"/);
    assert.match(textOf(counted), /\nsrc\/index\.tsx\t1\n/);

    const withContext = await client.callTool({
      name: "search",
      arguments: { project: "demo", ref: "fix/TEST-1", query: "export const", context: 1 },
    });
    assert.equal(withContext.isError, undefined);
    assert.match(textOf(withContext), /context="1"/);
    assert.match(textOf(withContext), /\n> 1: export const hello = 'fix\/TEST-1';\n/);

    const history = await client.callTool({
      name: "pickaxe",
      arguments: { project: "demo", ref: "fix/TEST-1", query: "Button" },
    });
    assert.equal(history.isError, undefined);
    assert.match(textOf(history), /<pickaxe project="demo" ref="fix\/TEST-1"[^>]*count="1"/);
    assert.match(textOf(history), /branch change/);
  });

  it("exposes log and get_commit, and reads history", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of ["log", "get_commit", "blame"]) {
      assert.ok(names.includes(expected), `${expected} is missing; saw ${names.join(", ")}`);
    }

    const history = await client.callTool({
      name: "log",
      arguments: { project: "demo", ref: "fix/TEST-1" },
    });
    assert.equal(history.isError, undefined);
    assert.match(
      textOf(history),
      /<log project="demo" ref="fix\/TEST-1" commit="[0-9a-f]{40}" count="2"/,
    );
    assert.match(textOf(history), /branch change/);

    const commit = await client.callTool({
      name: "get_commit",
      arguments: { project: "demo", rev: "fix/TEST-1" },
    });
    assert.equal(commit.isError, undefined);
    assert.match(textOf(commit), /<commit project="demo" rev="fix\/TEST-1" sha="[0-9a-f]{40}"/);
    assert.match(textOf(commit), /\nM\tsrc\/index\.tsx\t\+1 -1\n/);

    const blamed = await client.callTool({
      name: "blame",
      arguments: { project: "demo", ref: "fix/TEST-1", path: "src/index.tsx" },
    });
    assert.equal(blamed.isError, undefined);
    assert.match(
      textOf(blamed),
      /<blame project="demo" ref="fix\/TEST-1" commit="[0-9a-f]{40}" path="src\/index\.tsx" file_lines="1" groups="1" count="1"/,
    );
    assert.match(textOf(blamed), /\n  1: export const hello = 'fix\/TEST-1';\n/);
  });

  it("reads history through a pasted link, and names the tool a link belongs to", async () => {
    const resolved = await client.callTool({
      name: "resolve_ref",
      arguments: { project: "demo", ref: "fix/TEST-1" },
    });
    const sha = /commit="([0-9a-f]{40})"/.exec(textOf(resolved))?.[1];
    assert.ok(sha, `no sha in ${textOf(resolved)}`);

    const history = await client.callTool({
      name: "log",
      arguments: { url: "file:///demo/-/commits/fix/TEST-1/src/index.tsx" },
    });
    assert.equal(history.isError, undefined);
    assert.match(
      textOf(history),
      /<log project="demo" ref="fix\/TEST-1" commit="[0-9a-f]{40}" path="src\/index\.tsx"/,
    );

    const commit = await client.callTool({
      name: "get_commit",
      arguments: { url: `file:///demo/-/commit/${sha}` },
    });
    assert.equal(commit.isError, undefined);
    assert.match(textOf(commit), new RegExp(`<commit project="demo" rev="${sha}" sha="${sha}"`));

    const blamed = await client.callTool({
      name: "blame",
      arguments: { url: "file:///demo/-/blame/fix/TEST-1/src/index.tsx#L1-1" },
    });
    assert.equal(blamed.isError, undefined);
    assert.match(
      textOf(blamed),
      /<blame project="demo" ref="fix\/TEST-1" commit="[0-9a-f]{40}" path="src\/index\.tsx" lines="1-1" file_lines="1" groups="1" count="1"/,
    );

    // Each reader names the tool that does read the link it was handed, rather
    // than reading something the link did not point at.
    const wrongLog = await client.callTool({
      name: "log",
      arguments: { url: `file:///demo/-/commit/${sha}` },
    });
    assert.equal(wrongLog.isError, true);
    assert.match(textOf(wrongLog), /is a commit link; use get_commit for it\./);

    const wrongCommit = await client.callTool({
      name: "get_commit",
      arguments: { url: "file:///demo/-/blob/fix/TEST-1/src/index.tsx" },
    });
    assert.equal(wrongCommit.isError, true);
    assert.match(textOf(wrongCommit), /is a file link; use get_file for it\./);

    const wrongBlame = await client.callTool({
      name: "blame",
      arguments: { url: "file:///demo/-/tree/main/src" },
    });
    assert.equal(wrongBlame.isError, true);
    assert.match(textOf(wrongBlame), /is a directory link; use list_tree for it\./);

    // A project contradicting the link is caught before anything is read, and a
    // blame link naming no file is refused rather than blamed as something else.
    const conflicting = await client.callTool({
      name: "log",
      arguments: { project: "other/repo", url: "file:///demo/-/commits/main" },
    });
    assert.equal(conflicting.isError, true);
    assert.match(textOf(conflicting), /names "demo", but project="other\/repo"/);

    const noFile = await client.callTool({
      name: "blame",
      arguments: { url: "file:///demo/-/blame/fix/TEST-1" },
    });
    assert.equal(noFile.isError, true);
    assert.match(textOf(noFile), /names a ref but no file path/);
  });

  it("exposes compare and diff_file, and summarises a branch", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of ["compare", "diff_file"]) {
      assert.ok(names.includes(expected), `${expected} is missing; saw ${names.join(", ")}`);
    }

    const summary = await client.callTool({
      name: "compare",
      arguments: { project: "demo", from: "main", to: "fix/TEST-1" },
    });
    assert.equal(summary.isError, undefined);
    assert.match(
      textOf(summary),
      /<compare project="demo" from="main" to="fix\/TEST-1" from_commit="[0-9a-f]{40}" to_commit="[0-9a-f]{40}" merge_base="[0-9a-f]{40}"/,
    );
    assert.match(textOf(summary), /\nA\tsrc\/components\/Button\.tsx\t\+1 -0\n/);
    assert.match(textOf(summary), /\nM\tsrc\/index\.tsx\t\+1 -1\n/);

    const patch = await client.callTool({
      name: "diff_file",
      arguments: { project: "demo", path: "src/index.tsx", from: "main", to: "fix/TEST-1" },
    });
    assert.equal(patch.isError, undefined);
    assert.match(
      textOf(patch),
      /<diff project="demo" path="src\/index\.tsx" from="main" to="fix\/TEST-1"/,
    );
    assert.match(textOf(patch), /\n-export const hello = 'main';\n\+export const hello = 'fix\/TEST-1';\n/);
  });

  it("exposes parse_gitlab_url, and reads through a pasted link", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of ["parse_gitlab_url", "get_file", "list_tree", "search", "pickaxe"]) {
      assert.ok(names.includes(expected), `${expected} is missing; saw ${names.join(", ")}`);
    }

    // The fixture's GITLAB_HOST is a file URL, whose host is empty, so a link with
    // an empty host is the one that can match it here — the host check itself is
    // what makes the `https://elsewhere…` case below fail.
    const link = "file:///demo/-/blob/fix/TEST-1/src/index.tsx#L1-1";

    const parsed = await client.callTool({ name: "parse_gitlab_url", arguments: { url: link } });
    assert.equal(parsed.isError, undefined);
    assert.match(textOf(parsed), /project="demo"/);
    assert.match(textOf(parsed), /ref="fix\/TEST-1"/);
    assert.match(textOf(parsed), /path="src\/index\.tsx"/);
    assert.match(textOf(parsed), /ref_confirmed="true"/);

    const read = await client.callTool({ name: "get_file", arguments: { url: link } });
    assert.equal(read.isError, undefined);
    assert.match(textOf(read), /lines="1-1"/);
    assert.match(textOf(read), /1: export const hello = 'fix\/TEST-1';/);

    const tree = await client.callTool({
      name: "list_tree",
      arguments: { url: "file:///demo/-/tree/main/src" },
    });
    assert.equal(tree.isError, undefined);
    assert.match(textOf(tree), /src\/index\.tsx/);

    const foreign = await client.callTool({
      name: "get_file",
      arguments: { url: "https://elsewhere.example.com/demo/-/blob/main/src/index.tsx" },
    });
    assert.equal(foreign.isError, true);
    assert.match(textOf(foreign), /does not match GITLAB_HOST/);

    const refused = await client.callTool({
      name: "get_file",
      arguments: { url: "file:///demo/-/merge_requests/3" },
    });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /is a merge request link/);
  });

  it("reports a project once it has been used, and syncs it on demand", async () => {
    await client.callTool({
      name: "get_file",
      arguments: { project: "demo", ref: "main", path: "src/index.tsx" },
    });

    const listed = await client.callTool({ name: "list_repos", arguments: {} });
    assert.equal(listed.isError, undefined);
    assert.match(textOf(listed), /<repos count="1">/);
    assert.match(textOf(listed), /demo\tsource=mirror\tfreshness=ttl\tttl=600s\tpresent=true/);

    const synced = await client.callTool({
      name: "sync_repo",
      arguments: { project: "demo" },
    });
    assert.equal(synced.isError, undefined);
    assert.match(textOf(synced), /^<sync project="demo" synced_at="\d{4}-\d{2}-\d{2}T/);
  });

  it("lists refs with provenance", async () => {
    const response = await client.callTool({
      name: "list_refs",
      arguments: { project: "demo", kind: "all" },
    });
    const text = textOf(response);
    assert.match(text, /^<refs /);
    assert.match(text, /default_branch="main"/);
    assert.match(text, /synced_at="\d{4}-\d{2}-\d{2}T/);
    assert.match(text, /branch\t[0-9a-f]{12}\tfix\/TEST-1/);
    assert.match(text, /tag\t[0-9a-f]{12}\tv1\.0/);
  });

  it("filters refs by search", async () => {
    const response = await client.callTool({
      name: "list_refs",
      arguments: { project: "demo", search: "fix/" },
    });
    const text = textOf(response);
    assert.match(text, /count="1"/);
    assert.match(text, /fix\/TEST-1/);
  });

  it("resolves a branch to a full sha", async () => {
    const response = await client.callTool({
      name: "resolve_ref",
      arguments: { project: "demo", ref: "fix/TEST-1" },
    });
    const text = textOf(response);
    assert.match(text, /^<ref /);
    assert.match(text, /kind="branch"/);
    assert.match(text, /refname="refs\/heads\/fix\/TEST-1"/);
    assert.match(text, /commit="[0-9a-f]{40}"/);
  });

  it("suggests near misses for an unknown ref", async () => {
    const response = (await client.callTool({
      name: "resolve_ref",
      arguments: { project: "demo", ref: "fix/TEST-2" },
    })) as unknown as TextResult;

    assert.equal(response.isError, true);
    const text = textOf(response);
    assert.match(text, /Ref not found/);
    assert.match(text, /Did you mean:/);
    assert.match(text, /fix\/TEST-1 \(branch\)/);
  });

  it("returns file contents for a ref that is not checked out", async () => {
    const response = await client.callTool({
      name: "get_file",
      arguments: { project: "demo", ref: "fix/TEST-1", path: "src/index.tsx" },
    });
    const text = textOf(response);
    assert.match(text, /fix\/TEST-1/);
    assert.match(text, /<file /);
    assert.match(text, /commit="/);
  });

  it("reports provenance including synced_at", async () => {
    const response = await client.callTool({
      name: "get_file",
      arguments: { project: "demo", ref: "main", path: "src/index.tsx" },
    });
    assert.match(textOf(response), /synced_at="\d{4}-\d{2}-\d{2}T/);
  });

  it("reports a missing path as an error", async () => {
    const response = (await client.callTool({
      name: "get_file",
      arguments: { project: "demo", ref: "main", path: "src/nope.tsx" },
    })) as unknown as TextResult;
    assert.equal(response.isError, true);
    assert.match(textOf(response), /Path not found/);
  });

  it("reports a missing ref as an error", async () => {
    const response = (await client.callTool({
      name: "get_file",
      arguments: { project: "demo", ref: "ghost", path: "src/index.tsx" },
    })) as unknown as TextResult;
    assert.equal(response.isError, true);
    assert.match(textOf(response), /Ref not found/);
  });

  it("truncates when max_bytes is exceeded", async () => {
    const response = await client.callTool({
      name: "get_file",
      arguments: { project: "demo", ref: "main", path: "src/index.tsx", max_bytes: 5 },
    });
    assert.match(textOf(response), /truncated/);
  });

  it("lists a directory without reading any file", async () => {
    const response = await client.callTool({
      name: "list_tree",
      arguments: { project: "demo", ref: "fix/TEST-1", path: "src" },
    });
    const text = textOf(response);
    assert.match(text, /^<tree /);
    assert.match(text, /project="demo"/);
    assert.match(text, /ref="fix\/TEST-1"/);
    assert.match(text, /path="src"/);
    assert.match(text, /commit="[0-9a-f]{40}"/);
    assert.match(text, /synced_at="\d{4}-\d{2}-\d{2}T/);
    assert.match(text, /^tree\t-\tsrc\/components$/m);
    assert.match(text, /^blob\t\d+\tsrc\/index\.tsx$/m);
    assert.match(text, /<\/tree>$/);
  });

  it("walks a subtree recursively", async () => {
    const response = await client.callTool({
      name: "list_tree",
      arguments: { project: "demo", ref: "fix/TEST-1", recursive: true },
    });
    const text = textOf(response);
    assert.match(text, /recursive="true"/);
    assert.match(text, /^blob\t\d+\tdocs\/readme\.md$/m);
    assert.match(text, /^blob\t\d+\tsrc\/components\/Button\.tsx$/m);
  });

  it("points at get_file when asked to list a file", async () => {
    const response = (await client.callTool({
      name: "list_tree",
      arguments: { project: "demo", ref: "main", path: "src/index.tsx" },
    })) as unknown as TextResult;

    assert.equal(response.isError, true);
    const text = textOf(response);
    assert.match(text, /is a file/);
    assert.match(text, /get_file/);
  });

  it("hands the agent git's own words when a clone fails", async () => {
    // "ghost-project" is not in the fixture server, so the clone fails offline.
    const response = (await client.callTool({
      name: "get_file",
      arguments: { project: "ghost-project", ref: "main", path: "src/index.tsx" },
    })) as unknown as TextResult;

    assert.equal(response.isError, true);
    const text = textOf(response);
    assert.match(text, /Failed to read "src\/index\.tsx" at "main"/);
    assert.match(text, /Failed to clone ghost-project/);
    assert.match(text, /git said: /, "git's stderr must reach the agent, not be swallowed");
    assert.match(text, /does not appear to be a git repository/i);
  });

  it("exposes add_repo and remove_repo", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of ["add_repo", "remove_repo"]) {
      assert.ok(names.includes(expected), `${expected} is missing; saw ${names.join(", ")}`);
    }
  });

  it("reads from a registered clone, and can go back to a mirror", async () => {
    // A project name of its own, so pointing `demo` at a clone cannot change what
    // the tests above saw.
    const added = await client.callTool({
      name: "add_repo",
      arguments: { project: "cloned", local_path: fixture.work },
    });
    const addedText = textOf(added);
    assert.equal(added.isError, undefined);
    assert.match(addedText, /^<repo project="cloned" source="local"/);
    assert.match(addedText, /updated="false"/);
    assert.match(addedText, /nothing was fetched/);

    const listed = await client.callTool({ name: "list_repos", arguments: {} });
    assert.match(
      textOf(listed),
      /cloned\tsource=local\tfreshness=ttl\tttl=600s\tpresent=true/,
    );

    const read = await client.callTool({
      name: "get_file",
      arguments: { project: "cloned", ref: "fix/TEST-1", path: "src/index.tsx" },
    });
    assert.equal(read.isError, undefined);
    assert.match(textOf(read), /fix\/TEST-1/);

    const removed = await client.callTool({
      name: "remove_repo",
      arguments: { project: "cloned", delete_mirror: true },
    });
    const removedText = textOf(removed);
    assert.equal(removed.isError, undefined);
    assert.match(removedText, /^<removed project="cloned" registered="true"/);
    assert.match(removedText, /local clone was left alone/);

    const after = await client.callTool({ name: "list_repos", arguments: {} });
    assert.match(textOf(after), /count="1"/, "only the other project should remain");
  });
});

// The same surface with a mirror that cannot be refreshed. From the tool's side a
// rejected token, a missing VPN, and a broken remote are one situation: the cache
// can answer, and the only wrong thing to do is present it as a fresh answer.
describe("MCP protocol when the mirror cannot be refreshed", () => {
  const offlineConfig: Config = {
    host: pathToFileURL(fixture.root).href,
    token: "",
    cacheDir: path.join(fixture.root, "cache-offline"),
    gitBin: "git",
    // `always` fails the refresh on every call, not just once past the TTL.
    fetchMode: "always",
    fetchTtlSeconds: 600,
  };
  const git = new Git({ bin: "git" });
  let client: Client;

  before(async () => {
    const warm = new RepoStore({ ...offlineConfig, fetchMode: "ttl" }, git);
    await warm.readFile("demo", "main", "src/index.tsx");
    const dir = warm.mirrorPath("demo");
    const moved = await git.run(
      ["remote", "set-url", "origin", pathToFileURL(path.join(fixture.root, "gone.git")).href],
      { gitDir: dir },
    );
    assert.equal(moved.code, 0, "expected to be able to break the remote");

    const store = new RepoStore(offlineConfig, git);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(offlineConfig, store);
    await server.connect(serverTransport);

    client = new Client({ name: "protocol-test-offline", version: "0.0.0" });
    await client.connect(clientTransport);

    return async () => {
      await client.close();
      await server.close();
    };
  });

  it("reads a file from the cache and says the refresh failed", async () => {
    const text = textOf(
      await client.callTool({
        name: "get_file",
        arguments: { project: "demo", ref: "main", path: "src/index.tsx" },
      }),
    );
    assert.match(text, /export const hello/, "the cached file still answers");
    assert.match(text, /refresh_failed="true"/);
    assert.match(text, /\[refresh failed: /);
    assert.match(
      text,
      /git said: /,
      "the note must give the agent the diagnostic, not only the fact of failure",
    );
  });

  it("lists refs from the cache and says the refresh failed", async () => {
    const text = textOf(
      await client.callTool({ name: "list_refs", arguments: { project: "demo" } }),
    );
    assert.match(text, /^branch\t\w+\tmain\b/m);
    assert.match(text, /refresh_failed="true"/);
  });

  it("lists a tree from the cache and says the refresh failed", async () => {
    const text = textOf(
      await client.callTool({
        name: "list_tree",
        arguments: { project: "demo", ref: "main" },
      }),
    );
    assert.match(text, /^tree\t-\tsrc$/m);
    assert.match(text, /refresh_failed="true"/);
  });

  it("resolves a cached ref and says the refresh failed", async () => {
    const text = textOf(
      await client.callTool({
        name: "resolve_ref",
        arguments: { project: "demo", ref: "main" },
      }),
    );
    assert.match(text, /kind="branch"/);
    assert.match(text, /refresh_failed="true"/);
  });

  it("does not present a missing ref as proof of absence", async () => {
    const response = (await client.callTool({
      name: "resolve_ref",
      arguments: { project: "demo", ref: "no/such-branch" },
    })) as unknown as TextResult;

    assert.equal(response.isError, true);
    const text = textOf(response);
    assert.match(text, /Ref not found/);
    assert.match(text, /could not be refreshed/);
  });
});
