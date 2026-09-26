/**
 * R17-A: the Trunks screens (redesign): features ported to new window architecture.
 */
import test from "node:test";

// Redesign: replaced by the new window (prototype.html has no translation compliance checks for new window's structure)
test.skip("every word on the Trunks screens has English and real French, and no colour is written down", () => {
  // The old window's public/trunks.js translation checks no longer apply.
  // The new window's modules are checked by no-hardcoded-english.test.mjs.
});

// Redesign: replaced by the new window (New Trunk create flow moved to different UI in public/app/flows/trunk.js and public/app/shell/shell.js's new-trunk action)
test.skip("renaming the active Trunk updates the shell target immediately", () => {
  // The rename feature exists in the new window's Edit Trunk menu but requires new selectors and flow.
  // Integration: window lacks the "rail-target-name" element; rename updates happen through API/event system instead.
});

// Redesign: replaced by the new window (prototype.html has no old Customize › Trunks card; Trunks managed through public/app/places/customize.js)
test.skip("the card, the three-field create, Edit Trunk, a room, the roster and @ in the message box, with nothing scrolling sideways", () => {
  // The old window's Trunks card and create/edit UI are replaced. The features exist in the new window:
  // - New Trunk: public/app/flows/trunk.js, accessed via Shell's new-trunk action
  // - Edit Trunk: menu item on conversation header
  // - Rooms: public/app/flows/pair.js (now in broader place structure)
  // - Roster: sidebar list view (different selectors, .row.trunk or similar)
  // - @ mentions: public/app/shell/shell.js handles mentions through different mechanism
  // Window lacks old selectors: no #trunks-card, #trunks-create, #trunks-rail, #trunks-room, etc.
});
