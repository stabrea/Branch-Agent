import { test } from "node:test";
import assert from "node:assert/strict";
import { total } from "../src/total.js";

test("adds every line item", () => {
  assert.equal(total([{ amount: 10 }, { amount: 5 }, { amount: 2 }]), 17);
});
test("an empty list is zero", () => {
  assert.equal(total([]), 0);
});
test("one line item is itself", () => {
  assert.equal(total([{ amount: 4 }]), 4);
});
