// The wall around programs (wave mac3, os-sandbox). On macOS and Linux the system itself can stop a
// program Branch starts from changing things outside the workspace, reading where keys live, or
// reaching the internet. The deciding happens on the server (src/sandbox.ts, src/sandbox-wall.ts);
// this card only shows the owner's choice and sends it back. Every word is behind a key.
import { t } from "/i18n.js";
import { segmented, dropdown } from "/control-makers.js";

const $ = (id) => document.getElementById(id);
const modes = ["off", "when-needed", "on"];
const networks = ["none", "limited", "per-site", "open"];

async function api(body) {
  const response = await fetch("/api/os-sandbox", {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || t("os-sandbox.failed"));
  return data;
}

function worded(tag, key, className) {
  const node = document.createElement(tag);
  node.textContent = t(key);
  node.dataset.t = key;
  if (className) node.className = className;
  return node;
}

function choice(id, labelKey, values, prefix, current) {
  const label = worded("label", labelKey);
  label.htmlFor = id;
  // Handle three-way switch vs multi-option dropdown
  if (JSON.stringify(values) === JSON.stringify(["off", "when-needed", "on"])) {
    const options = values.map((v) => [v, `${prefix}.${v}`]);
    const control = segmented({ id, options, value: current });
    return [label, control];
  } else {
    const options = values.map((v) => [v, `${prefix}.${v}`]);
    const control = dropdown({ id, options, value: current });
    return [label, control];
  }
}

function lines(id, labelKey, text) {
  const label = worded("label", labelKey);
  label.htmlFor = id;
  const box = document.createElement("textarea");
  box.id = id;
  box.rows = 3;
  box.value = text;
  box.style.width = "100%";
  return [label, box];
}

/** "GITHUB_TOKEN api.github.com" per line, both ways. */
const sitesText = (sites) => Object.entries(sites).map(([name, site]) => `${name} ${site}`).join("\n");
function sitesFrom(text) {
  const out = {};
  for (const line of text.split("\n").map((each) => each.trim()).filter(Boolean)) {
    const [name, site] = line.split(/\s+/);
    if (name && site) out[name] = site;
  }
  return out;
}

function card() {
  let section = $("os-sandbox-card");
  if (section) return section;
  const after = $("firewall-card");
  if (!after) return null;
  section = document.createElement("section");
  section.className = "card";
  section.id = "os-sandbox-card";
  section.dataset.home = "settings:computer";
  /* DG-025: the wall saves as you go, as in the sample: a choice when it is picked, a list when you leave its box. */
  section.addEventListener("change", () => void send(section.querySelector("[role=status]")));
  after.after(section);
  return section;
}

function draw(data) {
  const section = card();
  if (!section) return;
  const { settings, computer } = data;
  const where = document.createElement("p");
  where.className = "subtle";
  where.style.overflowWrap = "anywhere";
  where.textContent = computer.available ? t("os-sandbox.available") : computer.reason;
  const status = document.createElement("p");
  status.className = "subtle";
  status.setAttribute("role", "status");
  section.replaceChildren(worded("h3", "settings.card.os-sandbox", "settings-card-title"), worded("p", "os-sandbox.lead", "subtle"), where,
    ...choice("os-sandbox-mode", "field.os-sandbox-mode", modes, "os-sandbox.mode", settings.mode),
    worded("p", "os-sandbox.modes", "subtle"),
    ...choice("os-sandbox-network", "field.os-sandbox-network", networks, "os-sandbox.network", settings.network),
    worded("p", "os-sandbox.network-note", "subtle"),
    ...lines("os-sandbox-keys", "field.os-sandbox-keys", sitesText(settings.keySites)),
    worded("p", "os-sandbox.keys-note", "subtle"),
    ...lines("os-sandbox-hidden", "field.os-sandbox-hidden", settings.unreadable.join("\n")),
    status);
}

/** Saves in flight: only the last one to come back may draw the card again, so an older answer never undoes a newer choice. */
let sending = 0;
async function send(status) {
  sending++;
  try {
    const data = await api({
      mode: $("os-sandbox-mode").value, network: $("os-sandbox-network").value,
      keySites: sitesFrom($("os-sandbox-keys").value),
      unreadable: $("os-sandbox-hidden").value.split("\n").map((each) => each.trim()).filter(Boolean),
    });
    last = data;
    /* Drawn again with what is now in force, unless you are still in the card: that would take your place away. */
    if (sending === 1 && !$("os-sandbox-card")?.contains(document.activeElement)) draw(data);
    const fresh = $("os-sandbox-card")?.querySelector("[role=status]");
    if (fresh) fresh.textContent = t("os-sandbox.saved");
  } catch (error) {
    status.textContent = error.message;
  } finally {
    sending--;
  }
}

let last = null;
async function refresh() {
  if (!sessionStorage.getItem("branch-token")) return;
  try { last = await api(); draw(last); } catch { /* signed out or offline: the next look tries again */ }
}

// Signing in shows the workspace a moment before the key is kept, so wait a little for the key.
async function afterSignIn(tries = 20) {
  for (let left = tries; left > 0 && !sessionStorage.getItem("branch-token"); left--)
    await new Promise((done) => setTimeout(done, 250));
  await refresh();
}

void refresh();
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !$("os-sandbox-card")) void refresh(); });
document.addEventListener("branch-language", () => { if (last) draw(last); });
const signedIn = $("workspace");
if (signedIn) new MutationObserver(() => { if (!signedIn.hidden) void afterSignIn(); }).observe(signedIn, { attributes: true, attributeFilter: ["hidden"] });
window.branchOsSandbox = { refresh };
