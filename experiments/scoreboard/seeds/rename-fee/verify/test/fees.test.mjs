import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFee } from "../src/fees.js";
import { invoiceTotal } from "../src/invoice.js";
import { receiptLines } from "../src/receipt.js";

test("the fee is two and a half per cent", () => {
  assert.equal(computeFee(200), 5);
});
test("the invoice adds the fee on", () => {
  assert.equal(invoiceTotal(200), 205);
});
test("the receipt prints the fee", () => {
  assert.deepEqual(receiptLines(200), ["amount 200", "fee 5"]);
});
