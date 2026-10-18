import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Git } from "../src/git.js";

describe("git token redaction", () => {
  it("replaces the token wherever it appears", () => {
    const git = new Git({ bin: "git", token: "glpat-secret" });
    assert.equal(git.redact("boom glpat-secret boom"), "boom *** boom");
    assert.equal(git.redact("glpat-secret and glpat-secret"), "*** and ***");
  });

  it("leaves text untouched when no token is configured", () => {
    const git = new Git({ bin: "git" });
    assert.equal(git.redact("nothing to hide"), "nothing to hide");
  });

  it("does not shred text when the token is an empty string", () => {
    // Without an explicit falsy check, "abc".split("").join("***") would turn
    // every character into a separator.
    const git = new Git({ bin: "git", token: "" });
    assert.equal(git.redact("anything"), "anything");
  });
});
