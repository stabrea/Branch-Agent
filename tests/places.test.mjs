import assert from "node:assert/strict";
import test from "node:test";
import { pressUntil } from "./places.mjs";

test("pressUntil uses one mouse activation when its effect appears", async () => {
  const actions = [];
  const target = {
    click: async () => actions.push("click"),
    focus: async () => actions.push("focus"),
    press: async () => actions.push("Enter"),
  };
  await pressUntil(target, async () => true, "save");
  assert.deepEqual(actions, ["click"]);
});

test("pressUntil checks a timed-out click before falling back to keyboard activation", async () => {
  const actions = [];
  let checks = 0;
  const target = {
    click: async () => { actions.push("click"); throw new Error("dispatch stalled"); },
    focus: async () => actions.push("focus"),
    press: async (key) => actions.push(key),
  };
  const warn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    await pressUntil(target, async () => ++checks === 2, "save");
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(actions, ["click", "focus", "Enter"]);
  assert.match(warnings[0], /dispatch stalled/);
});

test("pressUntil keeps both transport failures in the final error", async () => {
  const target = {
    click: async () => { throw new Error("mouse transport stopped"); },
    focus: async () => {},
    press: async () => { throw new Error("keyboard transport stopped"); },
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(pressUntil(target, async () => false, "settings to open"),
      /mouse transport stopped; Enter failed: keyboard transport stopped/);
  } finally {
    console.warn = warn;
  }
});
