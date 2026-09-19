import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("defaults host", () => assert.equal(loadConfig({ port: 80 }).host, "localhost"));
