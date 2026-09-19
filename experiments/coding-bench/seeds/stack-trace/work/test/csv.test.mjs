import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../src/csv.js";

test("parses rows", () => assert.deepEqual(parseCsv("a,b\n1,2"), [{ a: "1", b: "2" }]));
