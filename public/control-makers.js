/**
 * Batch 1: Single control factory for all Settings and custom controls.
 *
 * This module is imported by 36+ files that previously each invented their own
 * control rendering. Using one factory ensures:
 * - Consistent markup (every switch is the same, every dropdown is the same)
 * - Consistent options and wording (three-way always says "Off · When needed · On")
 * - Survival through 3s redraw cycles (no post-render decoration)
 * - Proper accessibility (roles, aria-describedby wired at render time)
 *
 * Each function returns just the control element (input, select, or button group).
 * The caller wraps it with field() or uses it directly.
 */

import { t } from "/i18n.js";

const say = (key, english) => { const word = t(key); return word === key ? english : word; };

/**
 * A toggle switch (on/off setting).
 * Returns: <input type="checkbox" class="sw" role="switch" id={id} aria-checked={checked}>
 *
 * The checkbox is emitted with class and role ready — no post-render decoration.
 * Caller does NOT need to add .sw or role="switch" afterwards.
 */
export function switchControl({ id, checked = false, onChange }) {
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.id = id;
  checkbox.className = "sw";
  checkbox.setAttribute("role", "switch");
  checkbox.checked = checked;
  checkbox.setAttribute("aria-checked", String(checked));

  checkbox.addEventListener("change", (e) => {
    checkbox.setAttribute("aria-checked", String(e.target.checked));
    onChange?.(e.target.checked);
  });

  return checkbox;
}

/**
 * A segmented choice control (three-way or multi-option).
 * Returns: <div role="group"><button role="button" aria-pressed={selected}>Off</button>...</div>
 *
 * For a three-way switch, options default to [["off", "Off"], ["when-needed", "When needed"], ["on", "On"]].
 * The segment is accessible via keyboard (arrow keys) and includes proper ARIA states.
 */
export function segmented({ id, options = null, value = "off", onChange }) {
  // Default to "Off · When needed · On" for three-way
  const opts = options || [
    ["off", "field.switch-off", "Off"],
    ["when-needed", "field.switch-when-needed", "When needed"],
    ["on", "field.switch-on", "On"]
  ];

  const group = document.createElement("div");
  group.className = "segmented-control";
  group.id = id;
  group.setAttribute("role", "group");

  const buttons = [];
  for (const [optValue, optKey, optEnglish] of opts) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "segmented-option";
    button.textContent = say(optKey, optEnglish);
    button.value = optValue;
    button.setAttribute("role", "button");

    const isSelected = optValue === value;
    button.setAttribute("aria-pressed", String(isSelected));

    button.addEventListener("click", () => {
      // Update all buttons' pressed state
      for (const btn of buttons) {
        const isNow = btn.value === optValue;
        btn.setAttribute("aria-pressed", String(isNow));
      }
      onChange?.(optValue);
    });

    button.addEventListener("keydown", (e) => {
      const idx = buttons.indexOf(button);
      let next = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        next = buttons[(idx + 1) % buttons.length];
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        next = buttons[(idx - 1 + buttons.length) % buttons.length];
      }
      if (next) {
        next.focus();
        // Simulate click to change value
        next.click();
      }
    });

    group.append(button);
    buttons.push(button);
  }

  return group;
}

/**
 * A dropdown (choice list with many options).
 * Returns: <select class="glass" id={id}>...</select>
 *
 * Emitted with class="glass" so glass-select.js decorates it at module load.
 * No native select without the glass class should exist in this codebase.
 */
export function dropdown({ id, options, value = "", onChange }) {
  const select = document.createElement("select");
  select.id = id;
  select.className = "glass";

  for (const [optValue, optKey, optEnglish] of options) {
    const option = document.createElement("option");
    option.value = optValue;
    option.textContent = say(optKey, optEnglish);
    option.selected = optValue === value;
    select.append(option);
  }

  select.addEventListener("change", (e) => {
    onChange?.(e.target.value);
  });

  return select;
}

// Export for testing and debugging
globalThis.branchControlMakers = { switchControl, segmented, dropdown };
