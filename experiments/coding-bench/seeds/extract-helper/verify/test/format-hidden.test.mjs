import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPrice } from "../src/format.js";

test("shared helper", () => assert.equal(formatPrice(1999), "$19.99"));
