import { test } from "node:test";
import assert from "node:assert/strict";
import { slug } from "../src/slug.js";

test("words become dashes", () => {
  assert.equal(slug("Hello World"), "hello-world");
});
test("no dash is left hanging at either end", () => {
  assert.equal(slug("  Hello, World!  "), "hello-world");
});
test("a trailing question mark leaves no dash", () => {
  assert.equal(slug("Is this it?"), "is-this-it");
});
