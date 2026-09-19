import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../src/csv.js";

test("parses rows", () => assert.deepEqual(parseCsv("a,b\n1,2"), [{ a: "1", b: "2" }]));
test("trailing newline", () => assert.deepEqual(parseCsv("a,b\n1,2\n"), [{ a: "1", b: "2" }]));
test("blank line in the middle", () => assert.deepEqual(parseCsv("a,b\n1,2\n\n3,4"), [{ a: "1", b: "2" }, { a: "3", b: "4" }]));
