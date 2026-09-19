import { test } from "node:test";
import assert from "node:assert/strict";
import { getUsr } from "../src/users.js";

test("finds Ada", () => assert.equal(getUsr(1).name, "Ada"));
