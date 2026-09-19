import { test } from "node:test";
import assert from "node:assert/strict";
import { mean } from "../src/stats.js";

test("mean", () => assert.equal(mean([1, 2, 3]), 2));
