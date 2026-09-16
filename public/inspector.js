/**
 * "Look inside": everything one task actually did, on one screen. Which models it asked and what
 * each round cost, every tool it used with what went in and what came back, whether the proof
 * checked out, the plan it worked through, what the reviewer said, and anything you told it while
 * it was running. The whole thing can be saved as a file.
 */
import { t, formatDate, formatNumber } from "/i18n.js";
import { fillMarkdown } from "/markdown.js";

const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
async function api(path) {
  const response = await fetch("/api/" + path, {
    headers: { authorization: "Bearer " + (sessionStorage.getItem("branch-token") || "") },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
/* The receipt words the context pane already uses, so the two screens agree. */
const OUTCOMES = {
  success: "checked and confirmed", unsigned: "no proof was kept", forged: "the proof did not match",
  modified: "changed after it was done", stalled: "stopped part-way", failed: "did not work", blocked: "not allowed",
};
const STATUS = { done: "finished", failed: "did not work", practice: "practice only", stopped: "stopped part-way" };

let current = null;

function section(key, children) {
  const node = el("section", undefined, "inspect-section");
  node.append(el("h3", t(key)));
  if (!children.length) node.append(el("p", t("inspector.nothing"), "context-empty"));
  else node.append(...children);
  return node;
}
const seconds = (value) => (value === null || value === undefined ? "" : t("inspector.seconds", { seconds: formatNumber(value) }));

/** One model round: who answered, how long it took, how big the prompt was, and what it cost. */
function roundRow(round) {
  const node = el("div", undefined, "inspect-row");
  node.append(el("strong", [round.preset, round.model].filter(Boolean).join(" · ") || "model"));
  const bits = [seconds(round.seconds)];
  if (round.promptTokens !== null) bits.push(t("inspector.prompt", { tokens: formatNumber(round.promptTokens) }));
  if (round.tokens.input !== null || round.tokens.output !== null)
    bits.push(t("inspector.tokens", { input: formatNumber(round.tokens.input ?? 0), output: formatNumber(round.tokens.output ?? 0) }));
  /* Say plainly whether the provider counted these or we did. */
  bits.push(t(round.reported ? "inspector.counted" : "inspector.estimated"));
  if (round.cost?.display) bits.push(round.cost.display);
  node.append(el("span", bits.filter(Boolean).join(" · "), "meta"));
  if (round.failed) node.append(el("span", round.error || "did not work", "inspect-bad"));
  return node;
}
/** One tool call, opening to show what went in and what came back. */
function callRow(call) {
  const node = el("details", undefined, "inspect-call");
  const summary = el("summary");
  summary.append(el("strong", call.name), el("span", [STATUS[call.status] ?? call.status, seconds(call.seconds),
    call.receipt ? `${t("inspector.receipt")}: ${OUTCOMES[call.receipt] ?? call.receipt}` : ""].filter(Boolean).join(" · "), "meta"));
  node.append(summary);
  for (const [label, value] of [[t("inspector.input"), call.input], [t("inspector.output"), call.output]]) {
    if (!value) continue;
    node.append(el("h4", label));
    node.append(fillMarkdown(el("div"), "```\n" + value + "\n```"));
  }
  return node;
}
const lineRow = (title, meta) => {
  const node = el("div", undefined, "inspect-row");
  node.append(el("strong", title));
  if (meta) node.append(el("span", meta, "meta"));
  return node;
};

function draw(view) {
  const body = $("inspect-body");
  const head = el("div", undefined, "inspect-head-lines");
  head.append(
    el("p", view.run?.prompt?.slice(0, 200) || "Task", "inspect-prompt"),
    el("p", [view.run?.status, view.style ? `working style: ${view.style}` : "", seconds(view.seconds), view.cost?.display,
      formatDate(view.run?.createdAt ?? Date.now())].filter(Boolean).join(" · "), "meta"),
  );
  body.replaceChildren(
    head,
    section("inspector.rounds", view.rounds.map(roundRow)),
    section("inspector.calls", view.calls.map(callRow)),
    // A think-then-act specialist's line of reasoning for each round; never part of the answer.
    section("inspector.thinking", (view.thinking ?? []).map((line) => lineRow(line.text, formatDate(line.at, { timeStyle: "medium" })))),
    section("inspector.plan", view.plan.map((step) => lineRow(step.title, step.detail))),
    section("inspector.verdicts", view.verdicts.map((v) => lineRow(v.verdict, v.reason))),
    section("inspector.steering", view.steering.map((s) => lineRow(s.text, formatDate(s.at)))),
    section("inspector.questions", view.questions.map((q) => lineRow(q.question, formatDate(q.at)))),
    section("inspector.timeline", (view.timeline ?? []).map((entry) =>
      lineRow(entry.title, [entry.result, entry.duration ? seconds(entry.duration) : "", formatDate(entry.timestamp, { timeStyle: "medium" })].filter(Boolean).join(" · ")))),
  );
}

/** Opens the panel for one task. Anything that can point at a run id can call this. */
export async function openInspector(runId) {
  const panel = $("inspect-panel");
  panel.hidden = false;
  $("inspect-body").replaceChildren(el("p", t("inspector.loading"), "meta"));
  try {
    current = await api(`runs/${runId}/inspect`);
    draw(current);
  } catch (error) {
    $("inspect-body").replaceChildren(el("p", error.message, "inspect-bad"));
  }
  $("inspect-close").focus();
}
function close() {
  $("inspect-panel").hidden = true;
  current = null;
}
/** Saves everything on the screen, and a little more, as one JSON file. */
function save() {
  if (!current) return;
  const blob = new Blob([JSON.stringify(current, null, 2)], { type: "application/json" });
  const link = el("a");
  link.href = URL.createObjectURL(blob);
  link.download = `branch-task-${current.run?.id ?? "unknown"}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
}
/** A "Look inside" button for any row that knows its run id. */
export function inspectButton(runId) {
  const node = el("button", t("inspector.open"), "text-button inspect-open");
  node.type = "button";
  node.dataset.runId = runId;
  node.addEventListener("click", () => void openInspector(runId));
  return node;
}
$("inspect-close").addEventListener("click", close);
$("inspect-export").addEventListener("click", save);
$("inspect-panel").addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
globalThis.branchInspector = { open: openInspector, button: inspectButton };
