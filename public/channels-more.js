/**
 * The "More chat apps" card: one row per chat service added in wave mac3, each with its own
 * off / when needed / on switch and the line to add to the connections file. It only reads and
 * writes the saved switches; see src/channels/parity-switch.ts for what each position does.
 * Its home is Customize, Chat apps.
 */
import { api, ownerAtWindow } from "/app.js";
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const POSITIONS = ["off", "when-needed", "on"];
let services = [];

function make(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

/** The line the owner adds to the connections file, with a placeholder for each setting. */
function example(service) {
  const fields = service.settings.map((name) => `"${name}": …`).join(", ");
  return `{"type": "${service.kind}", "id": "${service.kind}"${fields ? ", " + fields : ""}}`;
}

function row(service) {
  const node = make("details", undefined, "card-list");
  node.append(make("summary", `${service.name} · ${t(`channels-more.position.${service.switch}`)}`));
  node.append(make("p", t(`channels-more.service.${service.kind}`), "subtle"));
  const id = `channels-more-${service.kind}`;
  const label = make("label", t("channels-more.switch"));
  label.htmlFor = id;
  const select = make("select");
  select.id = id;
  select.name = service.kind;
  for (const position of POSITIONS) {
    const option = make("option", t(`channels-more.position.${position}`));
    option.value = position;
    select.append(option);
  }
  select.value = service.switch;
  select.disabled = !service.available;
  node.append(label, select);
  if (!service.available) node.append(make("p", t("channels-more.unavailable"), "field-note"));
  node.append(make("p", t("channels-more.add-line"), "field-note"), make("code", example(service)));
  const link = make("a", t("channels-more.docs"));
  link.href = service.docs; link.target = "_blank"; link.rel = "noreferrer";
  node.append(make("p"), link);
  return node;
}

function show() {
  const list = $("channels-more-list");
  if (!list) return;
  list.replaceChildren(...services.map(row));
}

async function load() {
  if (!$("channels-more-form") || !ownerAtWindow()) return; // household-followups: the chat apps are the owner's
  services = (await api("channels/parity")).services;
  show();
}

async function save(event) {
  event.preventDefault();
  const change = {};
  for (const service of services) {
    const select = $(`channels-more-${service.kind}`);
    if (select && !select.disabled && select.value !== service.switch) change[service.kind] = select.value;
  }
  const state = $("channels-more-state");
  try {
    services = (await api("channels/parity", change)).services;
    show();
    if (state) state.textContent = t("channels-more.saved");
  } catch (error) {
    if (state) state.textContent = t("channels-more.failed", { reason: error instanceof Error ? error.message : String(error) });
  }
}

$("channels-more-form")?.addEventListener("submit", save);
document.addEventListener("branch-language", show);
/* A card that will not load keeps its empty list; every service is off on a fresh install anyway.
   On a fresh window the key is not there yet, so the list is loaded again once the owner is in. */
load().catch(() => {});
const signedIn = $("workspace");
if (signedIn) new MutationObserver(() => { if (!signedIn.hidden) load().catch(() => {}); })
  .observe(signedIn, { attributes: true, attributeFilter: ["hidden"] });
/* household-followups: loaded again once the window is the owner's. */
document.addEventListener("branch-profile", (event) => { if (event.detail?.owner) load().catch(() => {}); });
