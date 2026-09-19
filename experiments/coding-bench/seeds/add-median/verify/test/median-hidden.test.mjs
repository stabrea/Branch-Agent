import { test } from "node:test";
import assert from "node:assert/strict";
import { median } from "../src/stats.js";

test("odd count", () => assert.equal(median([5, 1, 3]), 3));
test("even count averages the middle two", () => assert.equal(median([4, 1, 3, 2]), 2.5));
test("does not reorder the input", () => { const v = [3, 1, 2]; median(v); assert.deepEqual(v, [3, 1, 2]); });
test("empty throws", () => assert.throws(() => median([])));
