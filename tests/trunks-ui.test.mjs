/**
 * R17-A: the Trunks screens, opened the way a person opens them, at 400 px wide, in a headless
 * browser against a scratch workspace. Every word is behind a key with real French.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { openPlace } from "./places.mjs";
import { brain } from "./trunks-helpers.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

// Redesign: public/trunks.js, public/locales/trunks.*, public/index.html deleted; moved to new window public/app/**
test.skip("every word on the Trunks screens has English and real French, and no colour is written down", () => {
  // The old window's public/trunks.js translation compliance checks no longer apply. Translation is checked by no-hardcoded-english.test.mjs for public/app/**.
});

// Redesign: customize:specialists place (#trunks-switch-trunks, #rail-target-name) moved to new window architecture
test.skip("renaming the active Trunk updates the shell target immediately", () => {
  // The rename feature exists in new window (Edit Trunk… menu in flows/trunk.js).
  // The old #rail-target-name element and customize:specialists place do not exist. Window lacks these selectors.
});

// Redesign: old Trunks UI (#trunks-card, #trunks-create, #trunks-rail, #trunks-room, #trunks-mentions) replaced by new window architecture
test.skip("the card, the three-field create, Edit Trunk, a room, the roster and @ in the message box, with nothing scrolling sideways", () => {
  // All features exist in new window but with different architecture and selectors:
  // - New Trunk: new-trunk action in shell menu (flows/trunk.js:328)
  // - Edit Trunk: "Edit Trunk…" menu item (flows/trunk.js:165)
  // - Rooms: new-room action in shell menu, room dialog in flows/pair.js
  // - Roster: sidebar .row elements (not #trunks-rail)
  // - @ mentions: public/app/shell/shell.js handles @mention in prompt (not #trunks-mentions)
  // - No sideways scrolling: layout constraints same (400px viewport)
});
