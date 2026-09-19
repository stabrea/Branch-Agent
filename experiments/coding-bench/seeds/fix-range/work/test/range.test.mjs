import { test } from "node:test";
import assert from "node:assert/strict";
import { range } from "../src/range.js";

test("includes both ends", () => assert.deepEqual(range(1, 4), [1, 2, 3, 4]));
test("steps", () => assert.deepEqual(range(0, 10, 5), [0, 5, 10]));
test("single", () => assert.deepEqual(range(3, 3), [3]));
