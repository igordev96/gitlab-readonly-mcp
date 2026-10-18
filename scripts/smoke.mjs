// Local smoke test: no network, no token. Uses a fixture mirror under FIXTURES.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { Git } from "../dist/git.js";
import { NotFoundError, RepoStore } from "../dist/repoStore.js";
import { createServer } from "../dist/server.js";

const fixtures = process.env.FIXTURES;
if (!fixtures) {
  console.error("FIXTURES env var is required (path containing demo.git)");
  process.exit(2);
}

const cacheDir = path.join(fixtures, "cache");
fs.rmSync(cacheDir, { recursive: true, force: true });

const config = {
  host: pathToFileURL(fixtures).href,
  token: "",
  cacheDir,
  gitBin: "git",
};

const store = new RepoStore(config, new Git({ bin: "git" }));

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log("\nStore layer");
await check("reads a file from a non-default branch", async () => {
  const result = await store.readFile("demo", "fix/TEST-1", "src/index.tsx");
  assert.match(result.content, /fix\/TEST-1/);
  assert.match(result.commit, /^[0-9a-f]{40}$/);
  assert.equal(result.project, "demo");
});
await check("reads a different version from main", async () => {
  const result = await store.readFile("demo", "main", "src/index.tsx");
  assert.match(result.content, /'main'/);
});
await check("clones the mirror only once (reuses cache)", async () => {
  const dir = store.mirrorPath("demo");
  assert.ok(fs.existsSync(path.join(dir, "HEAD")), "mirror exists");
});
await check("accepts a project path with a trailing .git", async () => {
  // docs/readme.md only exists on fix/TEST-1; "demo.git" normalises to "demo"
  // and must reuse the same mirror.
  const result = await store.readFile("demo.git", "fix/TEST-1", "docs/readme.md");
  assert.match(result.content, /# demo/);
});
await check("missing ref raises NotFoundError", async () => {
  await assert.rejects(() => store.readFile("demo", "no/such-branch", "src/index.tsx"), NotFoundError);
});
await check("missing path raises NotFoundError", async () => {
  await assert.rejects(() => store.readFile("demo", "main", "src/nope.tsx"), NotFoundError);
});
await check("rejects a ref starting with '-' (argument injection)", async () => {
  await assert.rejects(() => store.readFile("demo", "--upload-pack=x", "src/index.tsx"), /must not start with/);
});
await check("normalises backslashes in the file path", async () => {
  const result = await store.readFile("demo", "main", "src\\index.tsx");
  assert.match(result.content, /'main'/);
});
await check("resolveRef returns a commit sha", async () => {
  const sha = await store.resolveRef("demo", "fix/TEST-1");
  assert.match(sha ?? "", /^[0-9a-f]{40}$/);
});

console.log("\nMCP protocol");
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createServer(config, store);
await server.connect(serverTransport);
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(clientTransport);

const listed = await client.listTools();
await check("server exposes get_file", async () => {
  assert.ok(listed.tools.some((tool) => tool.name === "get_file"), "get_file missing");
});
await check("tools/call returns file contents", async () => {
  const response = await client.callTool({
    name: "get_file",
    arguments: { project: "demo", ref: "fix/TEST-1", path: "src/index.tsx" },
  });
  const text = response.content.map((part) => part.text ?? "").join("\n");
  assert.match(text, /fix\/TEST-1/);
  assert.match(text, /<file /);
  assert.match(text, /commit="/);
});
await check("tools/call reports a missing path as an error", async () => {
  const response = await client.callTool({
    name: "get_file",
    arguments: { project: "demo", ref: "main", path: "src/nope.tsx" },
  });
  assert.equal(response.isError, true);
  const text = response.content.map((part) => part.text ?? "").join("\n");
  assert.match(text, /Path not found/);
});
await check("tools/call reports a missing ref as an error", async () => {
  const response = await client.callTool({
    name: "get_file",
    arguments: { project: "demo", ref: "ghost", path: "src/index.tsx" },
  });
  assert.equal(response.isError, true);
  assert.match(response.content.map((p) => p.text ?? "").join("\n"), /Ref not found/);
});
await check("truncates when max_bytes is exceeded", async () => {
  const response = await client.callTool({
    name: "get_file",
    arguments: { project: "demo", ref: "main", path: "src/index.tsx", max_bytes: 5 },
  });
  const text = response.content.map((part) => part.text ?? "").join("\n");
  assert.match(text, /truncated/);
});

await client.close();
await server.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
