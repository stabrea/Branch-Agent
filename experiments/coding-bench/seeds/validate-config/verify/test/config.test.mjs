import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("defaults host", () => assert.equal(loadConfig({ port: 80 }).host, "localhost"));
test("missing port", () => assert.throws(() => loadConfig({}), /port is required/));
test("port out of range", () => assert.throws(() => loadConfig({ port: 70000 }), /port must be between 1 and 65535/));
test("port not a number", () => assert.throws(() => loadConfig({ port: "80" }), /port must be between 1 and 65535/));
test("good port", () => assert.equal(loadConfig({ port: 8080 }).port, 8080));
