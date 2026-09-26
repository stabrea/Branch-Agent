/* Customize, pass 17 (patch17b.js, SHOWCASE17 rows 24, 27, 28, 32, 34, 36, 40, 42, 43, 116, 169 and 171).
   - Specialists: each row carries its working style and version, and Edit opens its card. The styles are the engine's six
     (GET /api/specialist-styles); choosing one writes a new draft version (specialists.propose through POST /api/action,
     the owner's own hand-run tool). "Run N test cases" runs the specialist's own evaluation (specialists.evaluate), Promote
     makes a passing draft the one in use (specialists.promote, refused in the engine's words until it passed) and Roll
     back returns to the one before (specialists.rollback). Everything is read back from GET /api/state specialists.
   - Specialists › Other coding agents (Advanced): no route lists the coding programs a task could hand work to, and
     handing work over starts a program here, so it stays greyed.
   - Tools, Advanced, by kind: skills (how often each is used, GET /api/learning-more/curator; the last install's written
     account, GET /api/skill-installs; checking a skill's writing and skills from other assistants have no route, so they
     stay greyed), plugins (what the chosen plugin asks for, POST /api/plugins/<id>/inspect, which runs none of its code;
     message filters, and example add-ons, GET /api/plugin-catalog/add-ons; copying an example installs code, so it stays
     greyed) and connectors (the tools Branch shares with other apps, GET /api/mcp/settings, with its address copied; the
     models behind its OpenAI-shaped address, GET /v1/models; its own agent card, GET /.well-known/agent.json, which the
     engine refuses in its own words while sharing with other assistants is off). No key or token is ever shown. */

import { esc, renderNow } from "../core/dom.js";
import { E, level, refresh } from "../core/state.js";
import { toast, openDlg, dialog } from "../core/ui.js";
import { api, token } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { pill17, when17, list17 } from "./parts17.js";
import { onDemo17, demoPlace17, demoDlg17 } from "./demo17.js";

let styles = [];
const specs = () => E.state?.specialists ?? [];
const specOf = (id) => specs().find((s) => s.id === id);

/* ---------- the specialist rows ---------- */
export function specLine(s) {
  const d = s.data ?? {}, def = d.definition ?? {};
  const parts = [`${def.style ?? "default"} style`];
  if (d.activeVersion) parts.push(`version ${d.activeVersion}`);
  if (d.version !== d.activeVersion) parts.push(`version ${d.version} is a draft`);
  return `<small class="spec-b17">${esc(parts.join(" · "))}</small>`;
}

function versionRows(s) {
  const d = s.data ?? {}, rows = [];
  const at = (v) => when17((v === d.version ? d.evidence : d.history?.find((h) => h.version === v)?.evidence)?.checkedAt ?? "");
  const row = (v, pill, button) => `<div class="prow"><span class="grow"><b>Version ${esc(v)}</b><small>${esc(at(v))}</small></span>${pill}${button}</div>`;
  if (d.version !== d.activeVersion) rows.push(row(d.version, pill17("work", "Draft"), `<button class="btn sm" type="button" data-act="specverb17" data-id="${esc(s.id)}" data-v="promote">Promote</button>`));
  if (d.activeVersion) rows.push(row(d.activeVersion, pill17("ok", "In use"), ""));
  if (d.previousActive) rows.push(row(d.previousActive, pill17("idle", "Earlier"), `<button class="btn ghost sm" type="button" data-act="specverb17" data-id="${esc(s.id)}" data-v="back">Roll back</button>`));
  return rows.join("");
}

function drawSpec(id) {
  const s = specOf(id);
  if (!s) return;
  const d = s.data ?? {}, def = d.definition ?? {}, style = def.style ?? "default";
  const checks = def.evaluation?.checks?.length ?? 0;
  const passed = d.evaluationPassed && d.evidence;
  const seg = styles.map((st) => `<button type="button" data-act="specstyleb17" data-id="${esc(id)}" data-v="${esc(st.style)}" aria-pressed="${st.style === style}">${esc(st.style)}</button>`).join("");
  const scroll = dialog()?.querySelector(".dlg-b")?.scrollTop ?? 0;
  openDlg({ title: def.name ?? "",
    body: `<p class="lead-b17">${esc(String(def.instructions ?? "").split("\n")[0])}</p>
      <div class="ctl"><b>Working style</b><span class="right"><span class="seg" role="group" aria-label="Working style">${seg}</span></span><small>${esc(styles.find((st) => st.style === style)?.summary ?? "")}</small></div>
      <div class="ctl"><b>Evaluation</b><span class="right">${passed ? pill17("ok", `${checks} of ${checks}`) : `<button class="btn sm" type="button" data-act="specevalb17" data-id="${esc(id)}">Run ${esc(checks)} test cases</button>`}</span><small></small></div>
      <div class="vers-b17">${versionRows(s)}</div>`,
    foot: '<button class="btn" type="button" data-act="dlg-close">Done</button>' });
  const body = dialog()?.querySelector(".dlg-b");
  if (body) body.scrollTop = scroll;
}

async function openSpec(id) {
  if (!styles.length) {
    try { styles = (await api("specialist-styles")).styles ?? []; } catch (error) { toast(error.message); return; }
  }
  drawSpec(id);
}

/* Each change is the engine's own tool, run by hand; the card is drawn again from what the engine then holds. */
async function specTool(el, tool, args) {
  el.disabled = true;
  try { await api("action", { tool, args }); } catch (error) { toast(error.message); }
  await refresh().catch((error) => toast(error.message));
  if (dialog()) drawSpec(el.dataset.id); // closed meanwhile: the card is not opened again
  renderNow();
}
function changeStyle(el) {
  const s = specOf(el.dataset.id);
  if (!s) return;
  const def = s.data?.definition ?? {};
  if (def.style === el.dataset.v) return;
  return specTool(el, "specialists.propose", { ...def, id: s.id, style: el.dataset.v });
}

/* ---------- Tools, Advanced ---------- */
const KEEPING = {
  skills: ["Keeping skills in shape", [
    ["curator", "spark", ["Retire skills nobody uses", "Looks back at recent tasks, drafts better skills and suggests retiring unused ones.", "Look back now"]],
    ["lint", "check", ["Check skills are well written", "Checks the name, description and steps, and that nothing a skill needs is missing.", "Check all"]],
    ["harness", "puzzle", ["Skills from other assistants", "A skill written for Claude Code, Codex or OpenClaw works here as it is.", "See which work"]],
    ["installacct", "doc", ["A written account of each install", "What it opened, what it checked and what it left out, each time a skill is added or removed.", "Read the last one"]]]],
  plugins: ["Checking plugins", [
    ["plugcheck", "shield", ["Check a plugin before it runs", "Reads what a plugin asks for and checks it against what it says it does.", "Check"]],
    ["valves", "sliders", ["Message filters", "Add-ons that change messages on the way in or out, each with settings you can turn.", "See them"]],
    ["examples", "puzzle", ["Example add-ons", "Small working examples to copy: a tool, a filter and a skill.", "Browse"]]]],
  mcp: ["Branch for other apps", [
    ["asmcp", "plug", ["Branch as a tool server", "Other assistants and apps can use your Trunks and Library as MCP tools.", "Set it up"]],
    ["oaiapi", "globe", ["One address for every model", "Programs that speak the OpenAI format can use all your connected models through Branch.", "See how"]],
    ["a2acard", "users", ["Branch’s own agent card", "What other assistants learn about Branch when they connect over A2A.", "Show the card"]]]],
};
const T = { plugin: null };
export function toolsSection(kind, selected) {
  if (kind === "plugins") T.plugin = selected ?? null;
  const set = KEEPING[kind];
  if (level() < 1 || !set) return "";
  return `<div class="sec x15-sec"><h2>${esc(set[0])}</h2><div class="rows">${set[1].map(([k, i, w]) => demoPlace17(k, i, w)).join("")}</div></div>`;
}
export const codingAgentsSection = () => (level() >= 1 ? `<div class="sec x15-sec"><h2>Other coding agents</h2><div class="rows">${demoPlace17("handoffcli", "term", ["Hand coding to another agent", "A Trunk can pass a coding job to Claude Code, Codex or Gemini CLI on this computer, then check the result.", "See how"])}</div></div>` : "");

/* A read from outside /api (the OpenAI-shaped address and the agent card), signed like every other request. */
async function outside(path) {
  const response = await fetch(path, { cache: "no-store", headers: token.get() ? { authorization: "Bearer " + token.get() } : {} });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || String(response.status));
  return body;
}
async function copy(text) {
  await navigator.clipboard.writeText(text);
  toast(`Copied ${text}.`);
}

function registerTools() {
  onDemo17("curator", { open: async () => {
    const view = await api("learning-more/curator");
    demoDlg17("curator", { title: "Retire skills nobody uses", lead: view.note, rows: list17(view.skills).map((s) => [s.name, s.lastUsedAt ? when17(s.lastUsedAt) : "", s.uses ? ["ok", "Keep"] : ["warn", "Retire?"]]) });
  } });
  onDemo17("installacct", { open: async () => {
    const last = list17((await api("skill-installs")).records)[0];
    demoDlg17("installacct", { title: "A written account of each install", lead: last ? `${last.name} · ${when17(last.at)}` : "", rows: (last?.steps ?? []).map((step) => [step, "", null]) });
  } });
  onDemo17("plugcheck", { open: async () => {
    const id = T.plugin ?? list17((await api("plugins")).plugins)[0]?.id;
    const shown = id ? await api(`plugins/${encodeURIComponent(id)}/inspect`, {}) : null;
    demoDlg17("plugcheck", { title: "Check a plugin before it runs", lead: shown?.name ?? "", rows: [...(shown?.permissions ?? []).map((p) => [p, "", null]), ...(shown?.tools ?? []).map((t) => [t.name, t.description, null])] });
  } });
  onDemo17("valves", { open: async () => {
    const { filters } = await api("plugin-catalog/add-ons");
    demoDlg17("valves", { title: "Message filters", lead: "Filters:", rows: list17(filters).map((f) => [f.name, f.stage, f.enabled ? ["ok", "On"] : ["idle", "Off"]]) });
  } });
  onDemo17("examples", { open: async () => {
    const { bundled } = await api("plugin-catalog/add-ons");
    demoDlg17("examples", { title: "Example add-ons", lead: "Examples:", go: "Copy", rows: list17(bundled).map((b) => [b.name ?? b.id, b.description ?? "", null]) });
  } });
  onDemo17("asmcp", { open: async () => {
    const view = await api("mcp/settings");
    demoDlg17("asmcp", { title: "Branch as a tool server", lead: "Other apps would see:", go: "Copy the address",
      rows: [...view.exposedTools.map((t) => [t, view.tools.find((x) => x.name === t)?.description ?? "", ["ok", "Shared"]]), ["Address", `${location.origin}/mcp`, ["idle", "Local"]]] });
  }, go: () => copy(`${location.origin}/mcp`) });
  onDemo17("oaiapi", { open: async () => {
    const { data } = await outside("/v1/models");
    demoDlg17("oaiapi", { title: "One address for every model", lead: "Point a program at:", go: "Copy the address",
      rows: [["Address", `${location.origin}/v1`, ["idle", "Local"]], ...list17(data).map((m) => [m.id, m.owned_by, null])] });
  }, go: () => copy(`${location.origin}/v1`) });
  onDemo17("a2acard", { open: async () => {
    const card = await outside("/.well-known/agent.json");
    demoDlg17("a2acard", { title: "Branch’s own agent card", lead: "The card says:", rows: [[card.name, card.description ?? "", null], ...list17(card.skills).map((s) => [s.name ?? s.id, s.description ?? "", null])] });
  } });
}

export function initCustomize17() {
  markLive(["specb17", "specstyleb17", "specevalb17", "specverb17"]);
  on("specb17", (el) => openSpec(el.dataset.id));
  on("specstyleb17", (el) => changeStyle(el));
  on("specevalb17", (el) => specTool(el, "specialists.evaluate", { id: el.dataset.id }));
  on("specverb17", (el) => specTool(el, el.dataset.v === "promote" ? "specialists.promote" : "specialists.rollback", { id: el.dataset.id }));
  registerTools();
}
