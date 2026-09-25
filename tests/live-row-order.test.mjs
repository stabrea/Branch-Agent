/**
 * Q195 (NAS 545cb4d): the working card and its question are shown under the conversation (dogfood B4), so they come
 * after it in the page too, and Tab and a screen reader meet them where they are seen, not before the conversation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the live row comes after the conversation in the page, as it is shown", async () => {
  const page = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const at = (marker) => { const index = page.indexOf(marker); assert.ok(index >= 0, marker); return index; };
  assert.ok(at('class="welcome"') < at('id="conversation"'), "control: the greeting, then the conversation");
  assert.ok(at('id="conversation"') < at('id="live-row"'), "the working card and its question after the conversation");
  assert.ok(at('id="live-row"') < at('id="plan-controls"'), "and before the plan's own rows, as they are shown");
});
