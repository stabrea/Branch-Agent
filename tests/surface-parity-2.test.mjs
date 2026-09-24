/* Part 2 of 3 of tests/surface-parity-suite.mjs (see the note at its top). */
import { chromium as _browserFile } from "playwright"; // a browser file, run one at a time (scripts/run-tests.mjs)
void _browserFile;
globalThis.branchTestPart = { index: 1, of: 3 };
await import("./surface-parity-suite.mjs");
