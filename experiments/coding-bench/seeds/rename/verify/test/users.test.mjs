import { test } from "node:test";
import assert from "node:assert/strict";
import { getUser } from "../src/users.js";
import { profileTitle } from "../src/profile.js";
import { isKnown } from "../src/admin.js";

test("finds Ada", () => assert.equal(getUser(1).name, "Ada"));
test("profile", () => assert.equal(profileTitle(1), "Profile of Ada"));
test("admin", () => assert.equal(isKnown(2), false));
