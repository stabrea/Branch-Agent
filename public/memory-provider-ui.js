/* FQ-memory.providers: the Memory screen's "Where facts are kept" card. Lets the owner switch the
   assistant's remember/recall/forget loop (memory.put/search/delete/update, and an accepted review
   suggestion) between this computer's database and an outside HTTP memory service, and read which
   one answers right now — src/memory-provider.ts is what actually decides, on every call. This is a
   different, smaller setting than "Outside memory services" (public/learning-more.js): that one adds
   Hindsight/Mem0/Honcho beside Branch's own memory; this one replaces it. */
import { api } from "/app.js";
import { t } from "/i18n.js";
import { dropdown } from "/control-makers.js";

const $ = (id) => document.getElementById(id);
const say = (key, english, values) => { const word = t(key, values); return word === key ? english : word; };
function make(tag, className, key, english) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (key) { node.dataset.t = key; node.textContent = say(key, english); }
  return node;
}
function plain(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
const words = (tag, className, text) => (typeof text === "string" ? plain(tag, text, className) : make(tag, className, ...text));
function described(id, labelWords, hintWords, control) {
  const label = words("label", "", labelWords);
  label.htmlFor = id;
  control.id = id;
  const note = words("p", "field-note", hintWords);
  note.id = `${id}-hint`;
  control.setAttribute("aria-describedby", note.id);
  return [label, control, note];
}
function input(value = "", type = "") {
  const node = document.createElement("input");
  if (type) node.type = type;
  node.value = value;
  return node;
}
const tell = (node, error) => { delete node.dataset.t; node.textContent = error.message ?? String(error); };
const done = (node, key = "memprovider.saved", english = "Saved.") => { node.dataset.t = key; node.textContent = say(key, english); };
function button([key, english], [hintKey, hint], handler) {
  const node = make("button", "quiet-button", key, english);
  node.type = "button";
  node.addEventListener("click", async () => {
    node.disabled = true;
    try { await handler(); } finally { node.disabled = false; }
  });
  const note = make("p", "field-note", hintKey, hint);
  node.setAttribute("aria-describedby", note.id = "memprovider-save-hint");
  return [node, note];
}

const ID = "memprovider-card";
const MODES = [["built-in", "memprovider.builtin", "This computer's database"], ["outside", "memprovider.outside", "An outside memory service"]];

function build(view) {
  const node = document.createElement("section");
  node.className = "card";
  node.id = ID;
  node.dataset.home = "library:memory";
  node.append(make("h2", "", "memprovider.title", "Where facts are kept"),
    make("p", "subtle", "memprovider.purpose", "Branch's own database, or an outside service that replaces it for saving, searching, correcting and forgetting facts. Switching does not move what is already saved."));
  const status = make("p", "subtle");
  status.setAttribute("role", "status");
  const mode = dropdown({ options: MODES, value: view.settings.mode });
  const url = input(view.settings.url, "url");
  const timeout = input(String(view.settings.timeoutMs), "number");
  Object.assign(timeout, { min: "500", max: "30000", step: "500" });
  const active = view.active === "outside"
    ? make("p", "meta", "memprovider.activeOutside", "Right now: an outside memory service")
    : make("p", "meta", "memprovider.activeBuiltin", "Right now: this computer's database");
  const urlField = described("memprovider-url", ["memprovider.url", "Outside service address"], ["memprovider.urlHint", "Needed once you switch to an outside service. Use https unless it is on this computer or your own network; your network rules apply."], url);
  const timeoutField = described("memprovider-timeout", ["memprovider.timeout", "Give up after (milliseconds)"], ["memprovider.timeoutHint", "How long one request to the outside service may take before Branch stops waiting."], timeout);
  const header = input(view.settings.header ?? "Authorization");
  const secret = input(view.settings.secret ?? "");
  const headerField = described("memprovider-header", ["memprovider.header", "Key header"], ["memprovider.headerHint", "The request header the service reads its key from, such as Authorization or X-API-Key."], header);
  const secretField = described("memprovider-secret", ["memprovider.secret", "Key name in the locker"], ["memprovider.secretHint", "The name of a key you keep in the locker, such as MEMORY_KEY, never the key itself. It is sent exactly as stored, so store \"Bearer …\" for an Authorization header. Leave empty to send none."], secret);
  const outsideOnly = [...urlField, ...timeoutField, ...secretField, ...headerField];
  const sync = () => { for (const field of outsideOnly) field.hidden = mode.value !== "outside"; };
  mode.addEventListener("change", sync);
  sync();
  node.append(...described("memprovider-mode", ["memprovider.mode", "Keep facts in"], ["memprovider.modeHint", "An outside service must answer six requests: read, list, save, search, forget and count facts."], mode),
    ...outsideOnly, active,
    ...button(["memprovider.save", "Save"], ["memprovider.saveHint", "An outside service needs a usable address before it can be switched on."], async () => {
      try {
        await api("memory/provider", { mode: mode.value, url: url.value.trim(), timeoutMs: Number(timeout.value) || undefined,
          header: header.value.trim(), secret: secret.value.trim() });
        done(status);
        await draw();
      } catch (error) { tell(status, error); }
    }));
  node.append(status);
  return node;
}

async function draw() {
  let view;
  try { view = await api("memory/provider"); } catch { return; }
  const fresh = build(view);
  const old = $(ID);
  if (old) old.replaceWith(fresh); else document.body.append(fresh);
}

function whenReady(work) {
  const ready = () => document.body.classList.contains("lx-ready") && $("workspace") && !$("workspace").hidden;
  if (ready()) { work(); return; }
  const watch = new MutationObserver(() => {
    if (!ready()) return;
    watch.disconnect();
    work();
  });
  watch.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  if ($("workspace")) watch.observe($("workspace"), { attributes: true, attributeFilter: ["hidden"] });
}

whenReady(() => { void draw(); });
