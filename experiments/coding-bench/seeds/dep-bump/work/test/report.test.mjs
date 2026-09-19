import { test } from "node:test";
import assert from "node:assert/strict";
import { reportTitle, fileName } from "../src/report.js";

const day = new Date(Date.UTC(2026, 2, 7));
test("title", () => assert.equal(reportTitle(day), "Report for 2026-03-07"));
test("file name", () => assert.equal(fileName(day), "report-20260307.txt"));
