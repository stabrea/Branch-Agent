/* Shared controls for the Grown Up Settings surface.
   Native inputs remain the source of truth so existing save, redraw, keyboard,
   and screen-reader behaviour survives the visual redesign. */
import { t } from "/i18n.js";

const labelFor = (option) => {
  const [, keyOrWords, english] = option;
  if (english === undefined) {
    const words = keyOrWords ?? String(option[0]);
    const translated = t(words);
    return translated === words ? words : translated;
  }
  const translated = t(keyOrWords);
  return translated === keyOrWords ? english : translated;
};

const translationKeyFor = (option) => option[2] !== undefined || t(option[1]) !== option[1] ? option[1] : "";

const setOptionalId = (node, id) => {
  if (id) node.id = id;
};

export function switchControl({ id, checked = false, onChange } = {}) {
  const control = document.createElement("input");
  control.type = "checkbox";
  control.className = "sw";
  control.setAttribute("role", "switch");
  setOptionalId(control, id);
  control.checked = Boolean(checked);
  control.addEventListener("change", () => onChange?.(control.checked));
  return control;
}

const DEFAULT_POSITIONS = [
  ["off", "field.switch-off", "Off"],
  ["when-needed", "field.switch-when-needed", "When needed"],
  ["on", "field.switch-on", "On"],
];

const orderedPositions = (options) =>
  options.length === 3 && ["off", "when-needed", "on"].every((choice) => options.some(([one]) => one === choice))
    ? ["off", "when-needed", "on"].map((choice) => options.find(([one]) => one === choice))
    : options;

function optionNode(option) {
  const node = document.createElement("option");
  node.value = option[0];
  node.textContent = labelFor(option);
  if (translationKeyFor(option)) node.dataset.t = option[1];
  return node;
}

function segmentNodes(control, positions) {
  return positions.map((option) => {
    const segment = document.createElement("span");
    segment.className = "segmented-option";
    segment.dataset.v = option[0];
    segment.textContent = labelFor(option);
    if (translationKeyFor(option)) segment.dataset.t = option[1];
    segment.setAttribute("aria-hidden", "true");
    control.append(segment);
    return segment;
  });
}

function bindSegmentedSource(source, segments, onChange) {
  const sync = () => {
    for (const segment of segments)
      segment.setAttribute("aria-pressed", String(segment.dataset.v === source.value));
  };
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  Object.defineProperty(source, "value", {
    get: () => nativeValue.get.call(source),
    set: (nextValue) => { nativeValue.set.call(source, String(nextValue)); sync(); },
  });

  for (const segment of segments) {
    segment.addEventListener("click", () => {
      if (source.disabled) return;
      source.focus({ preventScroll: true });
      if (source.value === segment.dataset.v) return;
      source.value = segment.dataset.v;
      source.dispatchEvent(new Event("input", { bubbles: true }));
      source.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  source.addEventListener("change", () => {
    sync();
    const restoreId = document.activeElement === source ? source.id : "";
    const changed = onChange?.(source.value);
    if (restoreId && changed instanceof Promise) {
      void changed.then(() => restoreSegmentedFocus(source, restoreId),
        () => restoreSegmentedFocus(source, restoreId));
    } else if (restoreId) restoreSegmentedFocus(source, restoreId);
  });
  source.addEventListener("input", sync);
  return sync;
}

function restoreSegmentedFocus(source, id) {
  if (document.activeElement !== source && document.activeElement !== document.body) return;
  document.getElementById(id)?.focus({ preventScroll: true });
}

function proxySegmentedControl(control, source, sync) {
  Object.defineProperty(control, "value", {
    get: () => source.value,
    set: (nextValue) => { source.value = String(nextValue); sync(); },
  });
  Object.defineProperty(control, "disabled", {
    get: () => source.disabled,
    set: (disabled) => { source.disabled = Boolean(disabled); control.toggleAttribute("data-disabled", source.disabled); },
  });
  Object.defineProperty(control, "id", {
    get: () => source.id,
    set: (nextId) => { source.id = String(nextId); },
    configurable: true,
  });
  const setAttribute = control.setAttribute.bind(control);
  control.setAttribute = (name, nextValue) => {
    setAttribute(name, nextValue);
    if (name === "aria-describedby" || name === "aria-label") source.setAttribute(name, nextValue);
  };
}

export function segmented({ id, options = DEFAULT_POSITIONS, value = "off", onChange } = {}) {
  const positions = orderedPositions(options);
  const control = document.createElement("div");
  control.className = `seg segmented-control${positions.length === 3 ? " tri" : ""}`;
  const source = document.createElement("select");
  source.className = "segmented-source";
  source.dataset.native = "keep";
  setOptionalId(source, id);
  source.append(...positions.map(optionNode));
  const sync = bindSegmentedSource(source, segmentNodes(control, positions), onChange);
  control.prepend(source);
  proxySegmentedControl(control, source, sync);
  source.value = String(value);
  sync();
  return control;
}

export function dropdown({ id, options = [], value = "", onChange } = {}) {
  if (options.length === 3 && ["off", "when-needed", "on"].every((choice) => options.some(([one]) => one === choice)))
    return segmented({ id, options, value, onChange });
  const control = document.createElement("select");
  control.className = "glass";
  control.setAttribute("aria-haspopup", "listbox");
  control.setAttribute("aria-expanded", "false");
  setOptionalId(control, id);
  let populated = false;

  control.setOptions = (nextOptions = []) => {
    const previous = populated ? control.value : undefined;
    control.replaceChildren(...nextOptions.map(optionNode));
    const preferred = [previous, String(value)].find((candidate) =>
      [...control.options].some((option) => option.value === candidate));
    if (preferred !== undefined) control.value = preferred;
    populated = true;
  };

  control.setOptions(options);
  control.addEventListener("change", () => onChange?.(control.value));
  return control;
}

export function dressSwitches(root = document) {
  const candidates = [];
  if (root instanceof Element) {
    if (root.matches("#settings-window input[type=checkbox]")) candidates.push(root);
    candidates.push(...[...root.querySelectorAll?.("input[type=checkbox]:not(.sw)") ?? []]
      .filter((control) => control.closest("#settings-window")));
  } else candidates.push(...root.querySelectorAll?.("#settings-window input[type=checkbox]:not(.sw)") ?? []);
  for (const control of candidates) {
    control.classList.add("sw");
    control.setAttribute("role", "switch");
    control.removeAttribute("aria-checked");
  }
}
dressSwitches();
new MutationObserver((changes) => {
  for (const change of changes) for (const node of change.addedNodes)
    if (node.nodeType === Node.ELEMENT_NODE) dressSwitches(node);
}).observe(document.body, { childList: true, subtree: true });

globalThis.branchControlMakers = { switchControl, segmented, dropdown, dressSwitches };
