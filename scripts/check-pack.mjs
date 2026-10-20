// Fail when the tarball npm would publish is not the built package.
//
// `npm pack --dry-run --json` is the only honest way to ask: it prints the file
// list npm computed, which is what an install actually receives. Asserting on a
// list built here would test what we believe npm does rather than what it does.
//
// The contract is deliberately narrow: the package is `dist/` plus the metadata
// every tarball carries. `src/`, `test/`, `docs/` and the tool configuration are
// working files. Shipping them is not a bug in the code, but it is the one kind
// of packaging mistake a check can catch before a user does.

import { execSync } from "node:child_process";

/** The entry point `bin` and `main` both point at. */
const REQUIRED = ["dist/index.js"];

/** npm adds these whether or not they are in `files`. */
const ALWAYS_SHIPPED = new Set([
  "package.json",
  "README.md",
  "LICENSE",
  "LICENSE.md",
  "CHANGELOG.md",
]);

/** Print the reasons and stop; nothing here is recoverable. */
function fail(lines) {
  for (const line of lines) {
    console.error(line);
  }
  process.exit(1);
}

let pack;

try {
  const raw = execSync("npm pack --dry-run --json --ignore-scripts", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  [pack] = JSON.parse(raw);
} catch (error) {
  fail([`check:pack: could not read the tarball listing: ${error.message}`]);
}

const shipped = pack.files.map((entry) => entry.path).toSorted();
const missing = REQUIRED.filter((required) => !shipped.includes(required));
const extra = shipped.filter((path) => !path.startsWith("dist/") && !ALWAYS_SHIPPED.has(path));

const problems = [];

if (missing.length > 0) {
  problems.push(
    `check:pack: ${pack.filename} would ship ${shipped.length} file(s), none of them ${missing.join(", ")}.`,
    "An install of that tarball would have no entry point to run.",
  );
}

if (extra.length > 0) {
  const preview = extra.slice(0, 6).join(", ");
  const more = extra.length > 6 ? ", and more" : "";
  problems.push(
    `check:pack: ${pack.filename} would ship ${extra.length} file(s) that are not the package: ${preview}${more}.`,
    "Add a `files` field to package.json so the tarball carries dist/ and nothing else.",
  );
}

if (problems.length > 0) {
  fail(problems);
}

console.log(
  `check:pack: ${pack.filename} ships ${shipped.length} file(s): the built output and its metadata.`,
);
