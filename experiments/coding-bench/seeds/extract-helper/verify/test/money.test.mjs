import { test } from "node:test";
import assert from "node:assert/strict";
import { cartLine } from "../src/cart.js";
import { invoiceTotal } from "../src/invoice.js";

test("cart line", () => assert.equal(cartLine({ name: "Tea", cents: 250 }), "Tea: $2.50"));
test("invoice", () => assert.equal(invoiceTotal([{ cents: 100 }, { cents: 5 }]), "Total $1.05"));
