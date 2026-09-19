import { test } from "node:test";
import assert from "node:assert/strict";
import { wrap } from "../src/wrap.js";

test("short text unchanged", () => assert.equal(wrap("hello world", 20), "hello world"));
test("breaks at spaces", () => assert.equal(wrap("the quick brown fox", 10), "the quick\nbrown fox"));
test("exact fit", () => assert.equal(wrap("abc def", 7), "abc def"));
test("long word alone", () => assert.equal(wrap("a supercalifragilistic b", 5), "a\nsupercalifragilistic\nb"));
test("keeps existing newlines", () => assert.equal(wrap("one two\nthree four", 7), "one two\nthree\nfour"));
