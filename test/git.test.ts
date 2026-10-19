import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Git, decodeOutput } from "../src/git.js";

describe("decodeOutput", () => {
  it("decodes a complete stream untouched", () => {
    assert.equal(decodeOutput(Buffer.from("héllo"), false), "héllo");
    assert.equal(decodeOutput(Buffer.from("a😀"), false), "a😀");
  });

  it("drops a two-byte character the cap cut in half", () => {
    const cut = Buffer.from("héllo").subarray(0, 2); // "h" and the lead byte of "é"
    assert.equal(cut.toString("utf8"), "h\uFFFD", "the raw decode invents a character");
    assert.equal(decodeOutput(cut, true), "h");
  });

  it("keeps a character whose last byte arrived before the cap", () => {
    assert.equal(decodeOutput(Buffer.from("héllo").subarray(0, 3), true), "hé");
  });

  it("drops an incomplete four-byte character", () => {
    assert.equal(decodeOutput(Buffer.from("a😀").subarray(0, 3), true), "a");
    assert.equal(decodeOutput(Buffer.from("a😀").subarray(0, 4), true), "a");
    assert.equal(decodeOutput(Buffer.from("a😀"), true), "a😀", "whole means whole");
  });

  it("keeps a replacement character the file really contains", () => {
    assert.equal(decodeOutput(Buffer.from("x\uFFFD"), true), "x\uFFFD");
  });

  it("leaves invalid bytes at the end alone, since they are the file's own", () => {
    // A stray continuation byte is not a character this cap cut; U+FFFD is the
    // honest rendering of input that is not UTF-8 at all.
    assert.equal(decodeOutput(Buffer.from([0x68, 0x80]), true), "h\uFFFD");
  });
});

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
