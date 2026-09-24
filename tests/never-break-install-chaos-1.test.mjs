/* Part 1 of 4 of tests/never-break-install-chaos-suite.mjs (see the note at its top). */
globalThis.branchTestPart = { index: 0, of: 4 };
await import("./never-break-install-chaos-suite.mjs");
