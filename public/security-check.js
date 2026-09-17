/**
 * The security self-check, on Settings → Permissions (docs/places.md: "when to check with the
 * owner, rules, limits"). One card: what it is for, the two switches, the last answer, and the
 * button that runs the check. "Fix what Branch can" only ever takes other people's access away
 * from Branch's own files; everything else is described, because it needs a decision.
 *
 * The findings' own sentences come from the engine in English; each check's name has a key, so the
 * list of names follows the chosen language.
 */

import { t } from "/i18n.js";

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
const keyed = (tag, key, words, className) => {
  const node = el(tag, t(key) === key ? words : t(key), className);
  node.dataset.t = key;
  return node;
};
async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

const positions = [
  ["off", "field.switch-off", "Off"],
  ["on", "field.switch-on", "On"],
  ["when-needed", "field.switch-when-needed", "Only when it is needed"],
];
const switches = [
  { name: "audit", label: ["field.security-audit-mode", "Check by itself"],
    note: ["settings.note.security-audit-mode", "Off: only when you press the button. Only when it is needed: your assistant can also run the check when you ask it whether your setup is safe. On: it also runs each time Branch starts."] },
  { name: "malware", label: ["field.security-malware-mode", "Check add-ons for malware"],
    note: ["settings.note.security-malware-mode", "Before a server fetched with npx, uvx or pipx starts, its name is looked up in the public list of harmful packages (OSV), and a listed one is refused."] },
];
const severityWords = {
  critical: ["security.severity.critical", "Urgent — not yet true", "var(--bad)", "var(--bad-tint)"],
  warn: ["security.severity.warn", "Not yet true", "var(--warn)", "var(--warn-tint)"],
  info: ["security.severity.info", "Worth a look", "var(--muted)", "var(--well)"],
};

function switchRow(spec, value, save) {
  const row = document.createDocumentFragment();
  const label = keyed("label", spec.label[0], spec.label[1]);
  label.htmlFor = `security-${spec.name}-mode`;
  const select = el("select");
  select.id = `security-${spec.name}-mode`;
  for (const [position, key, words] of positions) {
    const option = keyed("option", key, words);
    option.value = position;
    option.selected = position === value;
    select.append(option);
  }
  select.addEventListener("change", () => save({ [spec.name]: select.value }));
  row.append(label, select, keyed("p", spec.note[0], spec.note[1], "field-note"));
  return row;
}

function summaryText(report) {
  if (!report) return t("settings.security.not-checked");
  const { critical, warn, info, checks } = report.summary;
  if (critical + warn === 0) return t("settings.security.all-passed", { checks, info });
  return t("settings.security.summary", { checks, critical, warn, info });
}

function findingRow(finding) {
  const row = el("div", undefined, "item security-finding");
  row.dataset.check = finding.id;
  row.dataset.severity = finding.severity;
  const [key, words, colour, ground] = severityWords[finding.severity];
  const badge = keyed("span", key, words, "badge");
  badge.style.color = colour;
  badge.style.background = ground;
  const titleKey = `security.check.${finding.id}`;
  const title = el("p");
  title.append(el("strong", t(titleKey) === titleKey ? finding.title : t(titleKey)));
  row.append(badge, title, el("p", finding.detail), el("p", finding.advice, "field-note"));
  return row;
}

function results(card, report, fixed) {
  card.querySelector(".security-results")?.remove();
  const box = el("div", undefined, "security-results");
  const status = el("p", summaryText(report), "meta");
  status.setAttribute("role", "status");
  status.id = "security-summary";
  box.append(status);
  for (const finding of report?.findings ?? []) box.append(findingRow(finding));
  for (const result of fixed ?? []) box.append(el("p", `${result.path}: ${result.reason}`, "field-note"));
  card.querySelector("#security-run").before(box);
}

function buildCard(state) {
  const card = el("section", undefined, "card");
  card.id = "security-check";
  card.dataset.home = "settings:permissions";
  card.append(keyed("h2", "settings.card.security-check", "Security check"),
    keyed("p", "settings.note.security-check", "Looks over how Branch is set up on this computer — who else can read its files, who can reach it, and what it may do without asking — and puts right what it can."));
  const said = el("p", undefined, "meta");
  const save = async (change) => {
    try { await api("security-check/settings", change); said.textContent = t("settings.security.saved"); }
    catch (error) { said.textContent = error.message; }
  };
  for (const spec of switches) card.append(switchRow(spec, state.settings?.[spec.name] ?? "off", save));
  said.setAttribute("aria-live", "polite");
  const run = keyed("button", "action.run-the-security-check", "Run the check");
  run.id = "security-run";
  run.type = "button";
  const fix = keyed("button", "action.fix-what-branch-can", "Fix what Branch can", "quiet-button");
  fix.id = "security-fix";
  fix.type = "button";
  const note = keyed("p", "settings.note.security-fix", "Fixing only ever takes other people's access away from Branch's own files. Everything else needs a decision from you, so it is described instead.", "subtle");
  card.append(said, run, fix, note);
  const act = async (button, path, body) => {
    button.disabled = true;
    try { const answer = await api(path, body); results(card, answer.report, answer.fixed); }
    catch (error) { said.textContent = error.message; }
    finally { button.disabled = false; }
  };
  run.addEventListener("click", () => act(run, "security-check/run", {}));
  fix.addEventListener("click", () => act(fix, "security-check/fix", {}));
  results(card, state.report, null);
  return card;
}

/** Draws the card; public/layout.js moves it to Settings → Permissions. */
export async function drawSecurityCheck() {
  let state;
  try { state = await api("security-check"); } catch { return; }
  document.getElementById("security-check")?.remove();
  document.body.append(buildCard(state));
}

/* The card reads the owner's settings, which needs the session, so it is drawn on the way in as
   well as at load, and again when the language changes (its summary is assembled, not marked up). */
if (typeof document !== "undefined") {
  globalThis.branchSecurityCheckReady = () => { drawSecurityCheck().catch(() => {}); };
  document.addEventListener("branch-language", () => { drawSecurityCheck().catch(() => {}); });
  drawSecurityCheck().catch(() => {});
}
