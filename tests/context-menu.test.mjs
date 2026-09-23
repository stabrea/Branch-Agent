/* Right-click gives Cut, Copy, Paste and Select all in a field, and Copy on selected text (src/desktop/context-menu.ts).
   Owner-reported: there was no copy and paste. No window is opened here. */
import test from "node:test";
import assert from "node:assert/strict";
import { editMenuFor } from "../dist/desktop/context-menu.js";

const flags = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true, canUndo: false, canRedo: false, canDelete: true, canEditRichly: false };
const roles = (template) => template.filter((item) => item.role).map((item) => [item.role, item.enabled !== false]);

test("in the message box, right-click offers cut, copy, paste and select all", () => {
  assert.deepEqual(roles(editMenuFor({ isEditable: true, selectionText: "", editFlags: flags })),
    [["cut", true], ["copy", true], ["paste", true], ["selectAll", true]]);
  assert.deepEqual(roles(editMenuFor({ isEditable: true, selectionText: "", editFlags: { ...flags, canCut: false, canCopy: false } })),
    [["cut", false], ["copy", false], ["paste", true], ["selectAll", true]], "what cannot apply is shown greyed out");
});

test("on selected words in a reply, right-click offers copy", () => {
  assert.deepEqual(roles(editMenuFor({ isEditable: false, selectionText: "I can help with that", editFlags: flags })), [["copy", true]]);
});

test("anywhere else, right-click shows no empty menu", () => {
  assert.deepEqual(editMenuFor({ isEditable: false, selectionText: "  ", editFlags: flags }), []);
});
