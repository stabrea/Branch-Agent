import { test } from "node:test";
import assert from "node:assert/strict";
import { total } from "../src/store.js";

test("sums", async () => assert.equal(await total(["a", "b", "c"]), 6));
test("empty", async () => assert.equal(await total([]), 0));
