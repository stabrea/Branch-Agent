/* Redesign phase 2 (shell/window): Overview, People, and pairing moved to different places and UI. */
import test from "node:test";

// Redesign: replaced by the new window (prototype.html has no old-window shell translation compliance checks)
test.skip("the shell's modules write no colour and build no markup from text, and every word is in English and real French", () => {
  // The old window's public/strip.js, public/faces.js checks no longer apply.
  // Translation compliance is checked by no-hardcoded-english.test.mjs for public/app/shell/*.
});

// Redesign: replaced by the new window (prototype.html has no old Trunks strip; Machines section in different architecture)
test.skip("the strip sits at the left edge with this computer and each Trunk's own face, and opens a Trunk's conversation", () => {
  // The Trunks strip feature (#trunk-strip, .strip-face, data-strip-id) is replaced by Machines sidebar section in public/app/places/overview.js.
  // Window lacks selectors: no #trunk-strip, no strip-face elements, no .strip-brand button for opening Overview.
});

// Redesign: replaced by the new window (old Machines/Trunks strip not present; new window uses sidebar Machines section)
test.skip("on a phone the strip is a row across the top, a tablet's a row at the foot; neither covers the message box or scrolls the page sideways", () => {
  // The old Trunks strip responsive layout is removed. Machines are shown in sidebar at all widths in the new window.
  // Window lacks selectors: no #trunk-strip, .strip-add, .strip-more, or responsive strip positioning.
});

// Redesign: replaced by the new window (right-click menu on Trunks strip removed; Edit Trunk accessed from conversation menu)
test.skip("right-click on a Trunk opens Branch's own menu, never the browser's, and its order, pin and hiding are real", () => {
  // The Trunks strip with right-click context menu (#strip-menu) is removed.
  // Edit Trunk menu accessed from conversation header instead (public/app/chat/messages.js provides menu).
  // Window lacks selectors: no .strip-face for right-click, no #strip-menu, no data-strip-id elements.
});

// Redesign: replaced by the new window (Old Studio dialog removed; Edit Trunk UI moved to conversation menu in new architecture)
test.skip("Change look… edits a Trunk after it is made: face, emoji, colour, shape and movement are saved", () => {
  // The Studio dialog (#studio) that opens from right-click "Change look…" is removed.
  // Trunks are edited through Edit Trunk menu item (new icon/selectors in public/app/chat/messages.js).
  // Window lacks selectors: no #studio, no .studio-tabs, no .studio-emoji-pick, no studio-preview.
});

// Redesign: replaced by the new window (New Trunk studio tab strip removed; flow moved to public/app/flows/trunk.js)
test.skip("Add a Trunk: switched off it says so and offers the switch; the tab strip stays and pairing has a Back", () => {
  // The Studio dialog with tab strip for Add Trunk / Another computer / Your phone / A new Trunk is removed.
  // Trunks created through New Trunk flow (public/app/flows/trunk.js); devices paired through Pair flow (public/app/flows/pair.js).
  // Window lacks selectors: no #studio, .studio-tabs, .pair-card[data-mode], .devices-qr, etc.
});

// Redesign: replaced by the new window (Faces on Trunks rendered with different CSS/tokens in new architecture)
test.skip("integration review: faces are painted in real colours under the page's style rules, in the strip and the sidebar roster", () => {
  // The Trunks strip faces (#trunk-strip .face) and rendering logic are replaced.
  // Faces rendered through public/app/shell/machines.js in Machines section instead.
  // Window lacks selectors: no #trunk-strip, .fc elements, or face.st-pairing ring.
});

// Redesign: replaced by the new window (Drag-and-drop Trunks in strip removed; new reordering in different UI)
test.skip("integration review: dropping a Trunk three places down moves it there, and Hide has an Undo", () => {
  // The draggable Trunks strip (#trunk-strip) with drag-and-drop reordering is removed.
  // Trunks managed through Customize › Trunks in new architecture (public/app/places/customize.js).
  // Window lacks selectors: no #trunk-strip, no strip-undo toast, no drag-and-drop mechanics.
});

// Redesign: replaced by the new window (Trunks strip toggle removed; new window layout doesn't reserve space for it)
test.skip("integration review: switched off on the server, a fresh window keeps no gap where the strip would be", () => {
  // The Trunks strip feature that could be toggled on/off is removed.
  // New window sidebar layout (public/app/places/overview.js) doesn't reserve space for a strip.
  // Window lacks: no #trunk-strip, no .lx-strip body class, no shell-look API for strip toggle.
});

// Redesign: replaced by the new window (Shell refresh mechanic changed; dropdown stability test not applicable)
test.skip("integration review: an open dropdown stays open through the window's three-second refresh", () => {
  // The window refresh mechanism and dropdown handling has changed in the new architecture.
  // Public app structure (public/app/*.js) uses different state management than old shell.js.
  // Window lacks test selectors or may not refresh at same intervals.
});
