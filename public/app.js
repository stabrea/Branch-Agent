import { adoptSaved, appearanceChanges, currentAppearance, initAppearance } from "/appearance.js";
// Wave 6: replies render as markdown, and any task can be opened with "Look inside".
import { fillMarkdown, inlineNodes } from "/markdown.js";
// A phone paired in its browser sends its own secret with every request (src/remote/gateway-auth.ts).
import { installDeviceHeaders } from "/device-headers.js";
installDeviceHeaders();
// Wave mac3 (commands): the command list is shown in the chosen language.
import { applyLanguage, fromEnglish, t } from "/i18n.js";
import { taskWhen, taskWords } from "/task-state.js"; // Q51
export const $ = (id) => document.getElementById(id);
globalThis.toast = (message) => toast(message);
/* One notice area, one timer. A second notice inside the six seconds has to cancel the first
   one's timer, or that older timer hides the new notice almost as soon as it appears and it never
   comes back (it hid the "at most 4 MiB" notice on Windows, where the two arrive close together). */
let toastTimer = null;
export function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  const historyStatus = $("saved-history-status");
  if (historyStatus?.closest("dialog")?.open) historyStatus.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("toast").hidden = true;
  }, 6000);
}
const desktop = new URLSearchParams(location.search).get("desktop") === "1";
if (desktop) for (const home of document.querySelectorAll(".rail-home")) home.href = "/?desktop=1";
let savedAppearance;
let historyReadRevision = 0;
let conversationBusy = false;
let currentBranch = null;
let currentImported = false;
let currentTemporary = false;
let savedSearchRevision = 0;
let savedNextOffset = null;
let savedQuery = "";
let savedHistoryDialog = null;
const memoryEditors = new Map();
let memoryCapacityDraft = null;
let identityDraft = null, identityDirty = false, identityBusy = false;
let skillView = null, skillBusy = false;
let token = sessionStorage.getItem("branch-token") || "",
  state = null,
  sessionId = null,
  selectedRun = null;
const titles = {
  chat: "Conversation",
  runs: "Activity",
  usage: "Usage",
  memory: "Memory",
  specialists: "Specialists",
  procedures: "Procedures",
  schedules: "Schedules",
  settings: "Settings",
  skills: "Skills",
  documents: "Documents",
};
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
/* `method` is only given where the route needs something other than the usual GET-or-POST rule —
   PUT to save a flow, DELETE to take a line off the to-do list. */
async function api(path, body, method, signal) {
  const response = await fetch("/api/" + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    cache: "no-store",
    signal,
    headers: {
      authorization: "Bearer " + token,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "Request failed");
    /* household-followups: the owner's own things, refused because the window is on somebody else's
       profile. That is expected, so the page never reports it as something that went wrong. */
    if (response.status === 400 && /belongs to the owner\. Switch back to the owner's profile/.test(error.message)) error.household = true;
    throw error;
  }
  return data;
}
/* household-followups: whether the window is the owner's, as <html data-household> and a
   "branch-profile" event when it changes, so owner-only cards stop loading while it is not and load
   again once it is. A refusal they still meet in between is expected and never a page error. */
export function ownerAtWindow() {
  return document.documentElement.dataset.household !== "on";
}
export function noteWindowProfile(owner, { force = false } = {}) {
  if (!force && ownerAtWindow() === owner) return;
  const generation = Number(document.documentElement.dataset.profileGeneration || 0) + 1;
  document.documentElement.dataset.household = owner ? "off" : "on";
  document.documentElement.dataset.profileGeneration = String(generation);
  document.dispatchEvent(new CustomEvent("branch-profile", { detail: { owner, profileGeneration: generation } }));
}
function noteProfile(profile) {
  noteWindowProfile(!profile || profile.isOwner !== false);
}
window.addEventListener("unhandledrejection", (event) => {
  if (event.reason?.household === true) event.preventDefault();
});
async function action(tool, args) {
  const result = await api("action", { tool, args });
  await refresh();
  return result;
}
function button(label, handler) {
  const node = el("button", label);
  node.type = "button";
  node.addEventListener("click", async () => {
    node.disabled = true;
    try {
      await handler();
    } catch (e) {
      toast(e.message);
    } finally {
      node.disabled = node.classList.contains("conversation-switch") && conversationBusy;
    }
  });
  return node;
}
function displayView(view) {
  /* Wave 9 redesign: public/layout.js knows where every page now lives. */
  if (globalThis.branchLayout?.go(view)) return;
  document.querySelectorAll(".view").forEach((node) => {
    node.hidden = node.id !== view;
  });
  document
    .querySelectorAll(".nav")
    .forEach((node) =>
      node.classList.toggle("active", node.dataset.view === view),
    );
  $("page-title").textContent = titles[view];
  /* The open conversation is named beside the title, but only on the conversation. */
  $("thread-name").hidden = view !== "chat";
  if (view === "usage") { void window.branchUsage?.render().then(() => window.branchAllowed?.render()); }
}
document
  .querySelectorAll(".nav")
  .forEach((node) =>
    node.addEventListener("click", () => displayView(node.dataset.view)),
  );
/* Wave 8: an empty list says what the list is for and what to do about it, in that order.
   Pass a plain sentence, or ["what this is for", "what to do next"]. */
function list(id, items, render, empty) {
  const target = $(id);
  target.replaceChildren(...items.map(render));
  if (items.length) return;
  const box = el("div", undefined, "empty-state");
  const [what, next] = Array.isArray(empty) ? empty : [empty, ""];
  box.append(el("strong", what));
  if (next) box.append(el("p", next));
  target.append(box);
}
function recordCard(title, status) {
  const node = el("article", undefined, "item");
  if (status) node.append(el("span", status, "badge " + status));
  node.append(el("h3", title));
  return node;
}
function date(value) {
  return new Date(value).toLocaleString();
}
function renderRuns() {
  list(
    "runs-list",
    state.runs,
    (run) => {
      const node = recordCard(run.prompt, run.status);
      /* Wave 7: the reply on this screen is markdown too, rendered by the shared renderer so
         nothing a model wrote can become markup. */
      if (run.output) node.append(fillMarkdown(el("div", undefined, "markdown"), run.output));
      else node.append(el("p", "Working…"));
      const usage = el("div", undefined, "usage");
      usage.append(
        el(
          "span",
          `Estimated tokens: ${run.usage.estimatedInput} in / ${run.usage.estimatedOutput} out`,
        ),
        el(
          "span",
          run.usage.reports
            ? `Provider reported: ${run.usage.reportedInput} in / ${run.usage.reportedOutput} out`
            : "Provider usage: not reported",
        ),
        el("span", `Estimated cost: ${run.cost?.display ?? "no price on file"}`),
      );
      node.append(
        usage,
        el(
          "p",
          `${run.usage.unreportedCalls} calls without provider usage · ${run.usage.incompleteCalls} calls with incomplete output accounting`,
          "meta",
        ),
        el("p", modelLine(run.model), "meta"),
        el("p", date(run.createdAt), "meta"),
        button("See the raw record", () => showRun(run.id)),
      );
      // Wave 6: the same task, opened as one readable screen instead of raw events.
      if (globalThis.branchInspector) node.append(globalThis.branchInspector.button(run.id));
      // Wave 7: pick two tasks and see them side by side.
      if (globalThis.branchCompare) node.append(globalThis.branchCompare.button(run.id));
      for (const change of run.changes || []) {
        const row = el("div", undefined, "file-change");
        row.append(el("span", `${change.existed ? "Changed" : "Created"} ${change.path} (+${change.added} −${change.removed})`));
        if (change.diff) row.append(button("Show change", () => {
          const existing = row.querySelector("pre");
          if (existing) existing.remove(); else { const pre = el("pre", change.diff, "diff"); row.append(pre); }
        }));
        if (change.existed && change.versionId) row.append(button("Undo this change", async () => {
          await api("history/restore", { versionId: change.versionId }); toast(`${change.path} is back to how it was before.`); await refresh();
        }));
        node.append(row);
      }
      if (run.status === "running")
        node.append(
          button("Cancel", async () => {
            await api("runs/" + run.id + "/cancel", {});
            await refresh();
          }),
        );
      if (run.status === "interrupted")
        node.append(
          button("Continue where it stopped", async () => {
            toast("Continuing from where it stopped. Nothing already done is repeated.");
            await api("runs/" + run.id + "/resume", {});
            await refresh();
          }),
        );
      return node;
    },
    "Your completed and active runs will appear here.",
  );
}
async function showRun(id) {
  selectedRun = id;
  const detail = await api("runs/" + id);
  const target = $("run-detail");
  target.hidden = false;
  target.replaceChildren(
    el("h3", "Run trace"),
    el("p", id, "meta"),
    el("pre", JSON.stringify(detail.events, null, 2)),
  );
}
function renderMemory() {
  const capacity = state.memoryCapacity;
  $("memory-count").textContent = `${capacity.count} of ${capacity.maxFacts} saved facts`;
  $("memory-capacity").value = memoryCapacityDraft ?? capacity.maxFacts;
  const target = $("memory-list"), previous = new Map([...target.children].map(node => [node.dataset.memoryId, node]));
  const focused = target.contains(document.activeElement) ? document.activeElement : null;
  const selection = focused?.selectionStart == null ? null : [focused.selectionStart, focused.selectionEnd, focused.selectionDirection];
  const cards = state.memory.map(record => {
    const existing = previous.get(record.id);
    return memoryEditors.has(record.id) && existing?.querySelector(".memory-editor") ? existing : memoryCard(record);
  });
  for (const node of [...target.children]) if (!cards.includes(node)) node.remove();
  cards.forEach((node, index) => { if (target.children[index] !== node) target.insertBefore(node, target.children[index] || null); });
  if (!cards.length) target.append(el("div", "Save a preference, decision, or useful fact.", "empty"));
  renderLearning();
  if (!renderMemory.archivedOnce) { renderMemory.archivedOnce = true; void renderArchived(); }
  if (focused?.isConnected && document.activeElement !== focused) {
    focused.focus({ preventScroll: true });
    if (selection) focused.setSelectionRange(...selection);
  }
}
function renderLearning() {
  const learning = state.learning || {};
  if (document.activeElement !== $("learning-review")) $("learning-review").checked = !!learning.review;
  if (document.activeElement !== $("learning-approval")) $("learning-approval").checked = !!learning.requireApproval;
  if (document.activeElement !== $("learning-consolidate")) $("learning-consolidate").checked = !!learning.consolidateDaily;
  list("memory-proposals", state.memoryProposals || [], (p) => {
    const node = el("div", undefined, "record");
    const what = p.kind === "put" ? "Remember" : p.kind === "update" ? "Change a memory to" : p.kind === "delete" ? "Forget a memory" : "Note for a skill";
    node.append(el("strong", `${what}${p.text ? ": " + p.text : ""}`), el("p", `${p.source || ""}${p.runId ? " · from a task" : ""}`, "meta"));
    node.append(button("Accept", async () => {
      const done = await api(`memory/proposals/${p.id}/accept`, {});
      toast("Applied."); await refresh();
      // mac2/fly-core-2: a skill idea from the learning core opens as a draft in the skill editor.
      if (done?.applied?.skillDraft) globalThis.branchOpenSkillDraft?.(done.applied.skillDraft);
    }),
      button("Reject", async () => { await api(`memory/proposals/${p.id}/reject`, {}); await refresh(); }));
    return node;
  }, ["No suggestions waiting.", "When your assistant thinks something is worth remembering it will ask you here first."]);
  list("memory-checkpoints", state.memoryCheckpoints || [], (c) => {
    const node = el("div", undefined, "record");
    node.append(el("strong", c.label), el("p", `${c.memories} memories · ${c.skills} skills · ${date(c.createdAt)}`, "meta"),
      button("Put everything back to this", async () => { await api(`memory/checkpoints/${c.id}/restore`, {}); toast("Memories and skill versions restored."); await refresh(); }));
    return node;
  }, ["No checkpoints yet.", "A checkpoint saves every note and which skills are switched on, so you can put it all back exactly as it was."]);
}
async function saveLearning() {
  try { await api("memory/settings", { review: $("learning-review").checked, requireApproval: $("learning-approval").checked, consolidateDaily: $("learning-consolidate").checked }); await refresh(); }
  catch (e) { toast(e.message); }
}
$("learning-review").addEventListener("change", saveLearning);
$("learning-approval").addEventListener("change", saveLearning);
$("learning-consolidate").addEventListener("change", saveLearning);
$("consolidate-now").addEventListener("click", async () => {
  $("consolidate-now").disabled = true;
  try { const r = await api("memory/consolidate", {}); toast(r.skipped ? `Nothing to add: ${r.reason}.` : `Looked over ${r.runs} task(s) and made ${r.proposals} suggestion(s).`); await refresh(); }
  catch (e) { toast(e.message); } finally { $("consolidate-now").disabled = false; }
});
$("checkpoint-save").addEventListener("click", async () => {
  const label = $("checkpoint-label").value.trim();
  try { await api("memory/checkpoints", label ? { label } : {}); $("checkpoint-label").value = ""; toast("Checkpoint saved."); await refresh(); } catch (e) { toast(e.message); }
});
async function showMemoryHistory(node, record) {
  const { versions } = await api(`memory/versions?id=${encodeURIComponent(record.id)}`);
  let box = node.querySelector(".memory-history");
  if (box) { box.remove(); return; }
  box = el("div", undefined, "memory-history");
  if (!versions.length) box.append(el("p", "No earlier versions yet.", "meta"));
  for (const v of versions) {
    const row = el("div", undefined, "record");
    row.append(el("p", v.data.text), el("p", `Version ${v.revision} · ${v.reason} · ${date(v.createdAt)}`, "meta"),
      button("Restore this version", async () => { await api("memory/versions/restore", { id: record.id, revision: v.revision }); toast("Earlier version restored."); await refresh(); }));
    box.append(row);
  }
  node.append(box);
}
/** Q54: a fact's kind in plain words, as it was recorded when the fact was saved (src/memory-layers.ts). */
const memoryKinds = ["preference", "fact-about-person", "fact-about-world", "procedure-hint", "project-note", "task-scratch"];
const kindName = (kind) => (memoryKinds.includes(kind) ? t(`memory.kind.${kind}`) : "");
function memoryCard(record) {
  const node = recordCard(record.data.text);
  /* A saved fact is one line, so it keeps its heading and gets the inline formatting only:
     bold, italic, inline code and links, built as nodes so nothing in it can become markup. */
  node.querySelector("h3")?.replaceChildren(...inlineNodes(record.data.text));
  node.dataset.memoryId = record.id;
  const edit = button("Edit", () => { memoryEditors.set(record.id, { ...record.data, revision: record.revision }); renderMemory(); });
  edit.disabled = memoryEditors.has(record.id);
  // Q54-L1: Show recorded fields only: kind, conversation link (if run exists), source, revision
  const metaLine = el("p", undefined, "memory-meta");
  if (kindName(record.data.kind)) metaLine.append(el("span", kindName(record.data.kind), "memory-kind"));
  // Add conversation link if originRunId or sourceRunId resolves to a run from state
  const runId = record.data.originRunId || record.data.sourceRunId;
  if (runId && state?.runs) {
    const run = state.runs.find(r => r.id === runId);
    if (run) {
      if (metaLine.children.length > 0) metaLine.append(" · ");
      const link = el("a", t("memory.from-conversation"), "memory-from");
      link.href = "#";
      link.addEventListener("click", (e) => { e.preventDefault(); displayView("chat"); openConversation(run.sessionId); });
      metaLine.append(link);
    }
  }
  if (metaLine.children.length > 0) metaLine.append(" · ");
  metaLine.append(t("memory.revision", { n: record.revision }));
  node.append(metaLine);
  if (record.data.entity) node.append(el("p", `About ${record.data.entity}${record.data.attribute ? " · " + record.data.attribute : ""} · from ${date(record.data.validFrom || record.createdAt)}${record.data.validTo ? " until " + date(record.data.validTo) : ""}`, "meta"));
  if (record.data.scope && record.data.scope !== "private") node.append(el("p", record.data.scope === "shared" ? "Specialists may see this" : `Only the ${record.data.scope.slice(6)} specialist sees this`, "meta"));
  node.append(el("p", record.data.source), el("p", date(record.createdAt), "meta"), edit,
    button("History", () => showMemoryHistory(node, record)),
    button("Delete", async () => { await api("action", { tool: "memory.delete", args: { id: record.id } }); memoryEditors.delete(record.id); await refresh(); }));
  if (memoryEditors.has(record.id)) node.append(memoryEditor(record));
  return node;
}
function memoryEditor(record) {
  const draft = memoryEditors.get(record.id), editor = el("form", undefined, "memory-editor");
  const text = el("textarea"), source = el("input"), error = el("p", draft.error || "", "memory-error");
  text.value = draft.text; text.maxLength = 4000; text.required = true;
  text.setAttribute("aria-label", "Edit memory fact");
  source.value = draft.source; source.maxLength = 500; source.required = true;
  source.setAttribute("aria-label", "Edit memory source"); error.setAttribute("role", "alert");
  text.oninput = () => { draft.text = text.value; }; source.oninput = () => { draft.source = source.value; };
  const save = el("button", "Save changes"); save.type = "submit";
  editor.append(text, source, error, save, button("Cancel edit", async () => { memoryEditors.delete(record.id); await refresh(); }));
  editor.addEventListener("submit", async event => {
    event.preventDefault(); save.disabled = true; text.disabled = true; source.disabled = true;
    try {
      await api("action", { tool: "memory.update", args: { id: record.id, text: draft.text, source: draft.source, expectedRevision: draft.revision } });
      if (memoryEditors.get(record.id) === draft) memoryEditors.delete(record.id);
      await refresh(); toast("Memory updated.");
    } catch (failure) { draft.error = failure.message; error.textContent = failure.message; }
    finally {
      if (memoryEditors.get(record.id) === draft) {
        save.disabled = false; text.disabled = false; source.disabled = false;
      }
    }
  });
  return editor;
}
function specialistCard(record) {
  const d = record.data,
    node = recordCard(
      d.definition.name,
      d.activeVersion ? "active v" + d.activeVersion : "candidate",
    );
  node.append(
    el("p", d.definition.instructions),
    el(
      "p",
      `Candidate v${d.version} · ${d.evaluationPassed ? "checks passed" : "not evaluated or checks failed"}`,
    ),
    el("p", "Permissions: " + d.definition.permissions.join(", "), "meta"),
  );
  specialistActions(node, record);
  node.append(
    button("Revise", async () => {
      $("specialist-json").value = JSON.stringify(
        { ...d.definition, id: record.id },
        null,
        2,
      );
      $("specialist-form").closest("details").open = true;
    }),
  );
  if (d.activeVersion)
    node.append(
      button("Use in conversation", async () => {
        displayView("chat");
        $("prompt").value = `Delegate to specialist ${record.id}: `;
        $("prompt").focus();
      }),
    );
  return node;
}
function specialistActions(node, record) {
  node.append(
    button("Evaluate candidate", () =>
      action("specialists.evaluate", { id: record.id }),
    ),
  );
  if (record.data.evaluationPassed)
    node.append(
      button("Activate candidate", () =>
        action("specialists.promote", { id: record.id }),
      ),
    );
  if (record.data.previousActive)
    node.append(
      button("Roll back", () =>
        action("specialists.rollback", { id: record.id }),
      ),
    );
}
function renderSpecialists() {
  /* Wave 8: first, so a card that will not draw cannot take the composer's picker down with it. */
  fillSpecialistPicker();
  list(
    "specialists-list",
    state.specialists,
    specialistCard,
    "Propose a focused assistant and test its work before activation.",
  );
}
/** What a specialist is called, however its record is shaped. */
const specialistName = (record) =>
  String(record?.data?.definition?.name ?? record?.data?.name ?? record?.id ?? "A specialist").slice(0, 40);
/* Wave 8 (A1940): the composer's "who should answer" list, from the specialists switched on. */
function fillSpecialistPicker() {
  const picker = $("composer-specialist");
  if (!picker) return;
  const chosen = picker.value;
  picker.replaceChildren(new Option(picker.dataset.anyLabel || "Your assistant", ""));
  for (const record of state.specialists ?? []) {
    /* A candidate nobody has switched on yet cannot be asked anything. */
    if (!record.data?.activeVersion && record.data?.status !== "active") continue;
    picker.append(new Option(specialistName(record), record.id));
  }
  picker.value = chosen;
}
/**
 * A saved message that was put to a specialist, taken apart again: the words the owner actually
 * typed, and the name of the specialist it went to. A message that went to nobody in particular
 * comes back unchanged with no name.
 */
function delegationIn(content) {
  const found = /^Delegate to specialist ([0-9a-f-]{36}): ([\s\S]*)$/.exec(String(content ?? ""));
  if (!found) return { text: String(content ?? ""), specialist: null };
  const record = (state.specialists ?? []).find((one) => one.id === found[1]);
  return { text: found[2], specialist: record ? specialistName(record) : "A specialist" };
}
/** Which specialist the owner picked for this one message, or nothing at all. */
function chosenSpecialist() {
  const id = $("composer-specialist")?.value;
  if (!id) return null;
  return { id, name: specialistName((state.specialists ?? []).find((one) => one.id === id)) };
}
function renderProcedures() {
  list(
    "procedures-list",
    state.procedures,
    (record) => {
      const d = record.data,
        node = recordCard(d.definition.name, d.status);
      node.append(
        el(
          "p",
          `Version ${d.version} · ${d.definition.steps.length} steps · ${d.definition.preconditions.length} preconditions`,
        ),
      );
      node.append(
        button("Verify by executing", () =>
          action("procedures.verify", { id: record.id }),
        ),
      );
      if (d.status === "verified")
        node.append(
          button("Replay", () =>
            action("procedures.replay", { id: record.id }),
          ),
        );
      node.append(
        button("Revise", async () => {
          $("procedure-json").value = JSON.stringify(
            { ...d.definition, id: record.id },
            null,
            2,
          );
          $("procedure-form").closest("details").open = true;
        }),
      );
      return node;
    },
    "Turn a repeatable workflow into a recipe with checked results.",
  );
}
function renderSchedules() {
  list(
    "schedules-list",
    state.schedules,
    (record) => {
      const d = record.data,
        node = recordCard(d.prompt, d.status);
      node.append(el("p", `${d.kind} · ${date(d.dueAt)}`));
      if (d.intervalMs)
        node.append(el("p", `Repeats every ${d.intervalMs / 60000} minutes · ${d.runCount ?? 0} executions`, "meta"));
      if (d.dailyAt) node.append(el("p", `Every day at ${d.dailyAt} (${d.timezone}) · ${d.runCount ?? 0} executions`, "meta"));
      const history = Array.isArray(d.history) ? d.history : [];
      if (history.length) {
        const count = (status) => history.filter((h) => h.status === status).length;
        node.append(el("p", `History: ${count("completed")} finished · ${count("failed") + count("cancelled") + count("budget_exceeded")} failed · ${count("running")} running`, "meta"));
      }
      if (d.deliverTo) node.append(el("p", d.delivery?.error
        ? `Delivery to ${d.deliverTo.channel} failed: ${d.delivery.error}`
        : d.delivery ? `Delivered to ${d.deliverTo.channel} chat ${d.deliverTo.chatId}` : `Will be sent to ${d.deliverTo.channel} chat ${d.deliverTo.chatId}`, "meta"));
      if (d.hookToken) node.append(el("p", `Webhook: POST ${location.origin}/hooks/${record.id} with header x-branch-hook-token: ${d.hookToken}`, "meta"));
      if (d.kind === "check" && d.lastResult) node.append(el("p", `Last result: ${String(d.lastResult).slice(0, 200)}`, "meta"));
      if (["pending", "paused", "completed", "failed"].includes(d.status))
        node.append(button("Run now", async () => { await api(`schedules/${record.id}/trigger`, {}); await refresh(); }));
      if (["pending", "paused"].includes(d.status))
        node.append(
          button(d.status === "paused" ? "Resume" : "Pause", () =>
            action("schedules.pause", {
              id: record.id,
              paused: d.status !== "paused",
            }),
          ),
        );
      if (d.runId)
        node.append(
          button("View run", async () => {
            displayView("runs");
            await showRun(d.runId);
          }),
        );
      return node;
    },
    "Keep a reminder or task for later.",
  );
}
async function refresh() {
  const lookSince = appearanceChanges();
  state = await api("state");
  noteProfile(state.collab?.profile); // household-followups
  $("login").hidden = true;
  $("workspace").hidden = false;
  $("lock").hidden = desktop;
  $("connection").textContent = "Connected";
  $("connection").dataset.state = "ok";
  const active = state.activeModel ?? { provider: state.provider, presetName: state.provider, model: "" };
  const demo = active.provider === "offline-demo-fixture";
  $("provider").textContent = demo ? "Offline demonstration" : `${active.presetName} · ${active.model}`;
  const look = JSON.stringify(state.preferences);
  if (savedAppearance !== look) {
    savedAppearance = look;
    adoptSaved(state.preferences, lookSince);
  }
  /* A model running here is said plainly, so it is obvious when nothing leaves this computer. */
  $("context-provider").textContent = demo
    ? "Not connected"
    : active.local
      ? `${active.presetName} · on this computer`
      : active.presetName;
  /* The context pane offers "Connect a model" while nothing real is connected. */
  $("context-panel").dataset.connected = String(!demo);
  $("context-runs").textContent = state.runs.filter(
    (run) => run.status === "running",
  ).length;
  $("context-memory").textContent = state.memoryCapacity?.count ?? state.memory.length;
  $("context-tools").textContent = state.tools.length;
  $("demo-notice").hidden = !demo;
  renderRuns();
  renderMemory();
  renderSpecialists();
  renderProcedures();
  renderSchedules();
  renderAutomations();
  renderCollab();
  renderIdentity();
  renderSkills();
  renderModels();
  renderChatGPT();
  renderUpdates();
  renderFirstRun();
  renderProjects();
  /* household-followups: the locker and the chat apps are the owner's; not asked for while the window is somebody else's. */
  if (ownerAtWindow()) {
    void renderSecrets();
    void renderChannels();
  }
  renderSnapshots();
  renderAttention();
  void window.branchMcp?.render();
  void window.branchMcpWorkbench?.render();
  void window.branchApprovals?.render();
  void window.branchScreenControl?.render();
  void window.branchLinuxDesktop?.render(); // FQ-execution.desktop: the shared Linux desktop card
  // Batch 19 (wave 7): the rules read as sentences, under the same settings card.
  void window.branchRules?.render();
  void window.branchMisc?.render();
  void window.branchDiagnostics?.render();
  // Wave 8: the Lockdown switch, and the shape branched conversations make.
  void window.branchOther?.render();
  // Batch 26 (wave 8): where scripts run, what can reach out, the ceilings, the other computers,
  // and how long conversations are kept.
  void window.branchSandboxRemote?.render();
  // FQ-execution.host-bridge: the computer picker for running a program on one computer explicitly.
  void window.branchHostBridge?.render();
}
const notifiedAttention = new Set();
/* phase2/rooms (integration review): the Trunk that asked, named; a room member's question opens the room. */
function needsYouTitle(item) {
  if (!item.who) return t("attention.assistantNeedsYou");
  return item.room ? t("attention.trunkNeedsYouInRoom", { name: item.who, room: item.room }) : t("attention.trunkNeedsYou", { name: item.who });
}
/* mac7/residuals (integration): a Trunk's message whose task stopped to ask the owner: which Trunk, whose
   message, in its words, with Answer (the owner's next message there answers it) and Not now (the sender is told). */
function waitingMessageRow(item) {
  const row = el("div", undefined, "attention-row");
  const open = () => { displayView("chat"); openConversation(item.sessionId); };
  const act = (what) => async () => {
    try { await api(`trunks/messages/${item.id}/${what}`, {}); if (what === "answer") open(); await refresh(); } catch (e) { toast(e.message); }
  };
  row.dataset.waitingMessage = item.id;
  row.append(el("strong", t("attention.trunkWaiting", { name: item.to })),
    el("span", t(item.armed ? "attention.trunkWaitingArmed" : "attention.trunkWaitingAbout", { from: item.from, message: item.message })),
    item.armed ? button(t("attention.openConversation"), open) : button(t("attention.answer"), act("answer")),
    button(t("attention.notNow"), act("decline")));
  return row;
}
/* A task Branch closed on carries on from where it stopped, as the task list's own Continue does; the button stays
   off while it is sent, so one press is one task. */
function continueButton(item) {
  return button(t("attention.continue"), async () => { await api("runs/" + item.runId + "/resume", {}); await refresh(); });
}
function renderAttention() {
  const waiting = state.attention || [];
  const messages = state.trunkWaiting || [];
  const banner = $("attention");
  banner.hidden = !waiting.length && !messages.length;
  banner.replaceChildren(...messages.map(waitingMessageRow), ...waiting.map((item) => {
    const row = el("div", undefined, "attention-row");
    row.append(el("strong", needsYouTitle(item)), el("span", item.question),
      button(t(item.room ? "attention.openRoom" : "attention.openConversation"), () => { displayView("chat"); openConversation(item.open ?? item.sessionId); })); // phase2/rooms
    if (item.canContinue) row.append(continueButton(item));
    // Dogfood F8: a waiting task, or one a restart cut off, can be stopped from here.
    row.append(button(t("attention.stop"), async () => { await api("runs/" + item.runId + "/cancel", {}); await refresh(); }));
    return row;
  }));
  for (const item of waiting) {
    if (notifiedAttention.has(item.runId)) continue;
    notifiedAttention.add(item.runId);
    // R17-S17: the owner's sound, and "the banner only" (public/comfort.js).
    if (globalThis.branchComfort?.attention(item) === "handled") continue;
    if (typeof Notification === "undefined") continue;
    const show = () => {
      const note = new Notification(needsYouTitle(item), { body: item.question.slice(0, 200), tag: item.runId });
      note.onclick = () => { window.focus(); displayView("chat"); openConversation(item.open ?? item.sessionId); }; // phase2/rooms
    };
    if (Notification.permission === "granted") show();
    else if (Notification.permission !== "denied") Notification.requestPermission().then((p) => { if (p === "granted") show(); }).catch(() => undefined);
  }
}
$("health-run").addEventListener("click", async () => {
  $("health-run").disabled = true;
  try {
    const report = await api("health" + ($("health-probe").checked ? "?probe=1" : ""));
    list("health-list", report.items, (i) => {
      const node = el("div", undefined, "record");
      node.append(el("strong", `${i.ok ? "✓" : "✗"} ${i.name}`), el("p", i.summary, "meta"));
      if (i.fix) node.append(el("p", `What to do: ${i.fix}`));
      return node;
    }, "");
    toast(report.ok ? "Everything looks fine." : "Something needs attention; see the list.");
  } catch (e) { toast(e.message); } finally { $("health-run").disabled = false; }
});
$("backup-run").addEventListener("click", async () => {
  try { if (await exportArchive(await api("backup"), "exportBackup", "branch-backup.json")) toast("Backup saved."); } catch (e) { toast(e.message); }
});
function renderSnapshots() {
  list("snapshots-list", state.snapshots || [], (s) => {
    const node = el("div", undefined, "record");
    node.append(el("strong", s.label), el("p", `${s.files} files · ${Math.round(s.bytes / 1024)} KB · ${date(s.createdAt)}`, "meta"),
      button("Put the workspace back to this", async () => { await api(`history/snapshots/${s.id}/restore`, {}); toast("Workspace files restored."); await refresh(); }));
    return node;
  }, ["No snapshots yet.", "A snapshot keeps a copy of this whole workspace so you can go back to it after a change."]);
}
$("snapshot-save").addEventListener("click", async () => {
  const label = $("snapshot-label").value.trim();
  try { await api("history/snapshots", label ? { label } : {}); $("snapshot-label").value = ""; toast("Snapshot taken."); await refresh(); } catch (e) { toast(e.message); }
});
/** How a channel is doing, in words rather than a status code. */
function channelState(health) {
  if (!health) return "Connected";
  const words = { connected: "Connected", reconnecting: "Trying to reconnect", "needs attention": "Needs your attention" };
  return `${words[health.state] ?? health.state}${health.reason ? " · " + health.reason : ""}`;
}
async function renderChannels() {
  let summary;
  try { summary = await api("channels"); } catch { return; }
  // The address each chat service posts to, with its own unguessable word on the end.
  let posting = { addresses: [], settings: {}, waits: [] };
  try { posting = await api("channels/addresses"); } catch { /* older copies have none */ }
  const deliver = $("schedule-deliver");
  if (document.activeElement !== deliver) {
    const current = deliver.value;
    deliver.replaceChildren(el("option", "Nowhere (Activity only)"), ...summary.chats.map((chat) => {
      const option = el("option", `${chat.channel}: ${chat.title}`); option.value = JSON.stringify({ channel: chat.channel, chatId: chat.chatId }); return option;
    }));
    deliver.options[0].value = ""; deliver.value = current;
  }
  list("channels-list", summary.channels, (channel) => {
    const node = el("div", undefined, "record");
    node.append(el("strong", `${channel.kind}${channel.botName ? " · @" + channel.botName : ""}`),
      el("p", channelState(channel.health), "meta"),
      el("p", `${channel.activation === "always" ? "Answers every group message" : "Answers when mentioned or replied to"} · ${channel.pairing ? "new people pair with a code" : "only listed people"}`, "meta"));
    // Messenger and Instagram will not carry a message to anybody outside your own team until Meta
    // has looked over the app, so the card says so rather than letting you find out by trying.
    if (channel.needsAppReview)
      node.append(el("p", "Waiting on the service's app review: until it passes, only people on your own team can write to this.", "meta"));
    node.append(button("Check the connection", async () => {
      await renderChannels();
      const now = (await api("channels")).channels.find((c) => c.id === channel.id);
      toast(now ? channelState(now.health) : "That connection is no longer set up.");
    }));
    // Where this service posts to. It carries a long word made on this computer, so nobody can
    // find the address by guessing the name you gave the channel.
    const posts = posting.addresses.find((entry) => entry.channel === channel.id);
    if (posts) {
      node.append(el("p", "This service posts to this address. Paste it into the service's own settings; it is not something anyone can guess, so keep it to yourself.", "meta"));
      node.append(el("code", `${location.origin}${posts.address}`, "meta"));
      node.append(button("Copy this address", async () => {
        try { await navigator.clipboard.writeText(`${location.origin}${posts.address}`); toast("Address copied."); }
        catch { toast("Copying is not allowed here; select the address and copy it yourself."); }
      }));
      node.append(button("Give it a new address", async () => {
        await api("channels/addresses/rotate", { channel: channel.id });
        toast("New address made. Paste it into the service, or it will stop hearing from you.");
        await renderChannels();
      }));
      // mac7/lockout: a service being turned away used to be completely silent — the owner only
      // saw their messages stop. Now it says so here, beside the address it should be using.
      const wait = (posting.waits || []).find((entry) => entry.channel === channel.id);
      if (wait) {
        const minutes = Math.max(0, Math.ceil((wait.until - Date.now()) / 60000));
        const key = minutes > 0
          ? (wait.proven ? "channels.address.turned-away-signature" : "channels.address.turned-away")
          : "channels.address.turned-away-was";
        node.append(el("p", t(key, { minutes }), "meta"));
      }
      // mac7/channel-leaks: while the old shape is still answered the card says so AND says what it
      // costs, because it is a door anybody can find by guessing the name.
      if (posting.settings.acceptOldAddresses) {
        node.append(el("p", posting.settings.oldAddressesEndOn
          ? t("channels.address.old-accepted-until", { date: posting.settings.oldAddressesEndOn })
          : t("channels.address.old-accepted"), "meta"));
        node.append(el("p", t("channels.address.old-cost"), "meta"));
      }
    }
    for (const chat of summary.chats.filter((c) => c.channel === channel.id))
      node.append(button(`Send a test message to ${chat.title}`, async () => {
        try { const r = await api("channels/test", { channel: chat.channel, chatId: chat.chatId }); toast(r.messageId ? "Test message sent." : "Test message queued; it goes out when the channel is reachable."); }
        catch (e) { toast(e.message); }
      }));
    return node;
  }, ["No chat app connected.", "Connect one in the connections file and restart Branch; it will appear here."]);
  list("hooks-list", state.hooks || [], (hook) => {
    const node = el("div", undefined, "record");
    node.append(el("strong", `${hook.id} · when ${hook.event.replace(".", " ")}`), el("p", `${hook.enabled ? "On" : "Switched off after " + hook.failures + " failures"}${hook.lastError ? " · last problem: " + hook.lastError : ""}`, "meta"));
    if (!hook.enabled) node.append(button("Switch back on", async () => { await api(`hooks/${hook.id}/enable`, {}); await refresh(); await renderChannels(); }));
    return node;
  }, ["Nothing is set to happen automatically.", "You can have a small command run whenever something happens — a task finishing, a file changing. These are set up in the connections file."]);
  const people = [...summary.pending.map((p) => ({ ...p, label: `${p.name} is waiting · code ${p.code}` })),
    ...summary.approved.map((p) => ({ ...p, label: `${p.name} · approved` }))];
  list("pairings-list", people, (person) => {
    const node = el("div", undefined, "record");
    node.append(el("span", person.label), button("Remove", async () => {
      await api("channels/pairings/remove", { channel: person.channel, senderId: person.senderId }); await renderChannels();
    }));
    return node;
  }, "Nobody has written to your assistant through a channel yet.");
  list("deliveries-list", summary.outstanding || [], (item) => {
    const node = el("div", undefined, "record");
    const when = item.status === "dead" ? `Gave up after ${item.attempts} tries` : item.attempts ? `Will try again (${item.attempts} failed so far)` : "Waiting to send";
    node.append(el("strong", `${item.channel} chat ${item.chatId} · ${when}`), el("p", item.preview, "meta"));
    if (item.lastError) node.append(el("p", `Last problem: ${item.lastError}`, "meta"));
    node.append(button("Try again", async () => { await api(`channels/deliveries/${encodeURIComponent(item.id)}/retry`, {}); await renderChannels(); }));
    return node;
  }, ["Nothing is waiting to go out.", "Every message your assistant has sent through a chat app has already been delivered."]);
  await renderChatServices();
}
/** The other chat services, listed from the same data the assistant connects them with. */
async function renderChatServices() {
  let catalog;
  try { catalog = await api("channels/catalog"); } catch { return; }
  list("chat-services-list", catalog.services, (service) => {
    const node = el("details", undefined, "card-list");
    const carries = [service.can.files && "files", service.can.voiceIn && "voice notes", service.can.buttons && "buttons"].filter(Boolean);
    node.append(el("summary", `${service.name} (${service.id})`),
      el("p", service.note, "subtle"),
      el("p", `You need: ${service.needs.join("; ")}.`, "subtle"),
      el("p", `Words only${carries.length ? ", plus " + carries.join(" and ") : ""} · up to ${service.maxTextLength} characters at a time · ${service.canReceive ? "people can write to it" : "you can send to it, but nobody can write back"}.`, "meta"));
    const link = el("a", "How to set this up on their side");
    link.href = service.docs; link.target = "_blank"; link.rel = "noreferrer";
    node.append(link);
    return node;
  }, ["No chat services are listed in this copy.", "This is the list Branch knows how to connect to; a newer version may know more."]);
}
form("pairing-form", async () => {
  const approved = await api("channels/pairings/approve", { code: $("pairing-code").value.trim() });
  $("pairing-code").value = "";
  toast(`${approved.name} can now talk to your assistant.`);
  await renderChannels();
});
let editingProject = null;
function projectOptions(select, projects, value) {
  const focused = document.activeElement === select;
  select.replaceChildren(...projects.map((project) => { const option = el("option", project.name); option.value = project.id; return option; }));
  if (!focused) select.value = value;
}
function renderProjects() {
  const info = state.project;
  if (!info) return;
  projectOptions($("project-active"), info.all, info.active.id);
  projectOptions($("secret-project"), info.all, $("secret-project").value || info.active.id);
  const presets = state.models?.presets ?? [];
  presetOptions($("project-preset"), presets, "Workspace default", editingProject?.modelPreset ?? "");
  if (!editingProject) loadProject(info.active);
}
function loadProject(project) {
  editingProject = project;
  $("project-id").value = project.id; $("project-id").disabled = project.id === "default";
  $("project-name").value = project.name;
  $("project-instructions").value = project.instructions;
  $("project-folder").value = project.folder || "";
  $("project-preset").value = project.modelPreset ?? "";
  $("project-remove").hidden = project.id === "default";
}
$("project-active").addEventListener("change", async () => {
  try {
    const active = await api("projects/active", { active: $("project-active").value });
    loadProject(active); await refresh(); toast(`Now working in ${active.name}.`);
  } catch (e) { toast(e.message); }
});
$("project-new").addEventListener("click", () => {
  loadProject({ id: "", name: "", instructions: "", modelPreset: null, repository: "" });
  $("project-id").disabled = false; $("project-remove").hidden = true; $("project-id").focus();
});
$("project-remove").addEventListener("click", async () => {
  if (!editingProject || editingProject.id === "default") return;
  try { await api(`projects/${editingProject.id}/remove`, {}); editingProject = null; await refresh(); toast("Project removed."); }
  catch (e) { toast(e.message); }
});
form("projects-form", async () => {
  const saved = await api("projects", {
    id: $("project-id").value.trim(), name: $("project-name").value.trim(),
    instructions: $("project-instructions").value, modelPreset: $("project-preset").value || null, repository: editingProject?.repository ?? "",
    folder: $("project-folder").value.trim(),
  });
  loadProject(saved); await refresh();
});
async function renderSecrets() {
  const project = $("secret-project").value || state.project?.active.id;
  if (!project) return;
  let listing;
  try { listing = await api(`secrets/${project}`); } catch { return; }
  list("secrets-list", listing.secrets, (secret) => {
    const node = el("div", undefined, "record");
    node.append(el("strong", secret.name), el("span", ` · saved ${date(secret.createdAt)}`, "meta"),
      button("Remove", async () => { await api(`secrets/${project}/${secret.name}/remove`, {}); await renderSecrets(); toast("Secret removed."); }));
    globalThis.branchSecretMarks?.(node, secret); // phase2/accounts: its service's mark and a plain name (public/service-marks.js)
    return node;
  }, ["No secrets saved here yet.", "A secret is a password or key your assistant needs. Add one below and it is locked away on this computer."]);
}
$("secret-project").addEventListener("change", () => { void renderSecrets(); });
form("secrets-form", async () => {
  const value = $("secret-value").value;
  $("secret-value").value = "";
  await api("secrets", { project: $("secret-project").value, name: $("secret-name").value.trim(), value });
  $("secret-name").value = "";
  await renderSecrets();
});
let firstRunDoor = null, firstRunTimer = null, firstRunLooked = false;
function renderFirstRun() {
  const show = state.onboarding && !state.onboarding.done;
  $("first-run").hidden = !show;
  if (!show) { clearTimeout(firstRunTimer); return; }
  if (!firstRunLooked) { firstRunLooked = true; void lookForLocalModel(); }
  const active = state.activeModel;
  if (active && active.provider !== "offline-demo-fixture" && firstRunDoor !== "demo") {
    $("first-run-status").textContent = `${active.presetName} is ready. Try it, or start straight away.`;
    $("first-run-test").hidden = false;
    $("first-run-done").hidden = false;
  }
}
/* A model program already answering on this computer (Ollama, LM Studio) gets a door of its own. */
async function lookForLocalModel() {
  const found = await api("providers/local").catch(() => ({ local: [] }));
  const first = found.local?.[0];
  if (!first) return;
  $("door-local").hidden = false;
  $("door-local").dataset.runtime = first.runtime;
}
function chooseDoor(door) {
  firstRunDoor = door;
  for (const id of ["door-chatgpt", "door-key", "door-local", "door-demo"]) $(id).classList.toggle("selected", id === "door-" + door);
  $("first-run-done").hidden = true;
  $("first-run-test").hidden = door === "demo";
}
$("door-chatgpt").addEventListener("click", async () => {
  chooseDoor("chatgpt");
  const prompt = await startChatGPTLogin();
  if (!prompt) return;
  $("first-run-status").textContent = `Enter ${prompt.userCode} on the sign-in page that just opened (${prompt.verificationUrl}). This page updates by itself when you finish.`;
  globalThis.branchDeviceCode?.($("first-run-status"), prompt.userCode); // OWNER-LIST 7: the code, copyable (public/first-run-next.js)
  const poll = async () => {
    const status = await api("chatgpt/status").catch(() => null);
    if (status?.signedIn) { await refresh(); $("first-run-status").textContent = "Signed in. Try it, or start straight away."; $("first-run-done").hidden = false; return; }
    if ($("first-run").hidden) return;
    firstRunTimer = setTimeout(poll, 3000);
  };
  firstRunTimer = setTimeout(poll, 3000);
});
$("door-key").addEventListener("click", () => {
  chooseDoor("key");
  $("first-run-status").textContent = window.branchDesktop
    ? "Paste your key in Settings → Models, then come back here and try it."
    : "Set BRANCH_PROVIDER, BRANCH_ENDPOINT, BRANCH_MODEL and BRANCH_API_KEY where you start Branch, restart it, then try it here.";
  if (window.branchDesktop) { displayView("settings"); $("model-provider").focus(); }
});
$("door-local").addEventListener("click", () => {
  chooseDoor("local");
  $("first-run-status").textContent = "Pick the model in Settings → Models → On this computer, then come back here and try it.";
  if (!globalThis.branchLayout?.reveal("local-models-card")) displayView("settings:models");
});
/* Trying it without an account is one click: no second button to find. */
$("door-demo").addEventListener("click", async () => {
  chooseDoor("demo");
  await finishFirstRun();
});
$("first-run-test").addEventListener("click", async () => {
  $("first-run-test").disabled = true;
  $("first-run-status").textContent = "Trying it…";
  try {
    const result = await api("models/test", {});
    $("first-run-status").textContent = `${result.presetName} answered in ${(result.ms / 1000).toFixed(1)} s${result.reply ? `: “${result.reply}”` : "."}`;
    $("first-run-done").hidden = false;
  } catch (e) {
    // OWNER-LIST 7: try again, a key instead or another way, with the raw words behind Details (public/first-run-next.js)
    if (!globalThis.branchFirstRunTrouble?.($("first-run-status"), e)) $("first-run-status").textContent = e.message;
  } finally { $("first-run-test").disabled = false; }
});
async function finishFirstRun() {
  try {
    await api("onboarding", { done: true }); await refresh(); toast("You're set. Say hello."); $("prompt").focus();
    globalThis.branchFirstRunDone?.(); // R17-S06: what to try next (public/first-run-next.js)
  }
  catch (e) { toast(e.message); }
}
$("first-run-done").addEventListener("click", () => void finishFirstRun());
let chatgptTimer = null, chatgptBusy = false;
function chatgptPoll(active) {
  clearTimeout(chatgptTimer);
  if (active) chatgptTimer = setTimeout(() => renderChatGPT(), 3000);
}
async function renderChatGPT() {
  if (!state.chatgpt?.configured) {
    $("chatgpt-status").textContent = "ChatGPT sign-in is not available in this launch.";
    $("chatgpt-login").disabled = true;
    return;
  }
  let status;
  try { status = await api("chatgpt/status"); } catch (e) { $("chatgpt-status").textContent = e.message; return; }
  const pending = status.pending && new Date(status.pending.expiresAt) > new Date();
  $("chatgpt-code-block").hidden = !pending;
  if (pending) {
    $("chatgpt-code").textContent = status.pending.userCode;
    $("chatgpt-open").href = status.pending.verificationUrl;
  }
  $("chatgpt-login").hidden = status.signedIn;
  $("chatgpt-login").disabled = chatgptBusy || pending;
  $("chatgpt-login").textContent = pending ? "Waiting for sign-in…" : "Sign in with ChatGPT";
  $("chatgpt-logout").hidden = !status.signedIn;
  $("chatgpt-status").textContent = status.signedIn
    ? `Signed in${status.email ? " as " + status.email : ""}. ChatGPT models are available in the model list.`
    : status.lastError || (pending ? "Sign-in started." : "Not signed in.");
  chatgptPoll(pending);
  if (status.signedIn && !$("session-model").options.length) await refresh();
}
async function startChatGPTLogin() {
  if (chatgptBusy) return null;
  chatgptBusy = true;
  try {
    const prompt = await api("chatgpt/login", {});
    $("chatgpt-code").textContent = prompt.userCode;
    $("chatgpt-open").href = prompt.verificationUrl;
    $("chatgpt-code-block").hidden = false;
    if (window.branchDesktop) window.branchDesktop.openExternal(prompt.verificationUrl).catch(() => undefined);
    return prompt;
  } catch (e) { toast(e.message); return null; } finally { chatgptBusy = false; await renderChatGPT(); }
}
$("chatgpt-login").addEventListener("click", () => { void startChatGPTLogin(); });
$("chatgpt-open").addEventListener("click", (event) => {
  if (!window.branchDesktop) return;
  event.preventDefault();
  window.branchDesktop.openExternal($("chatgpt-open").href).catch((e) => toast(e.message));
});
$("chatgpt-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("chatgpt-code").textContent); toast("Code copied."); }
  catch { toast("Select the code and copy it."); }
});
$("chatgpt-logout").addEventListener("click", async () => {
  try { await api("chatgpt/logout", {}); toast("Signed out of ChatGPT."); await refresh(); }
  catch (e) { toast(e.message); }
});
let updatesTimer = null;
/*
 * mac7/clean-uninstall: what is running and whether a newer one exists, in plain words, from the
 * update check that already runs. Nothing installs itself: "Update and restart" is still a button.
 */
function showVersions(status) {
  const running = state.version;
  const newest = status?.release?.latestVersion;
  $("updates-version").textContent = `Branch Agent ${running}`;
  const line = $("updates-newest");
  if (!line) return;
  if (status?.phase === "unsupported") line.textContent = `Running ${running}. This copy cannot check for newer versions.`;
  else if (!newest) line.textContent = `Running ${running}. Branch has not looked for a newer one yet.`;
  else if (status.release.available) line.textContent = `Running ${running}, newest is ${newest}.`;
  else line.textContent = `Running ${running}, which is the newest.`;
}
/*
 * Q55: the installed build (version and the commit it was built from, "not recorded" when the build
 * carries none), what a failed update left in place, and the offered release's own notes as plain text.
 */
let lastUpdateStatus = null;
function showBuild(status) {
  lastUpdateStatus = status;
  const installed = status?.installed;
  $("updates-build-version").textContent = installed?.version || state.version || t("updates.build.not-recorded");
  const commit = $("updates-build-commit");
  commit.textContent = installed?.commit ? installed.commit.slice(0, 12) : t("updates.build.not-recorded");
  commit.title = installed?.commit || "";
  const outcome = $("updates-outcome");
  outcome.hidden = !(status?.phase === "error" && status.outcome?.kept);
  // A failure after the background engine was closed says so: that engine stays closed until the next sign-in.
  const kept = status?.outcome?.backgroundStopped ? "updates.outcome.kept-stopped" : "updates.outcome.kept";
  outcome.textContent = outcome.hidden ? "" : t(kept, { version: status.outcome.kept });
  const release = status?.release;
  $("updates-notes").hidden = !release?.available;
  if (!release?.available) return;
  // A Dev build has no version of its own until it is built; it is named by its change.
  const dev = release.channel === "dev" && release.commit;
  $("updates-notes-title").textContent = dev ? t("updates.notes.title-dev", { change: release.commit.slice(0, 7) }) : t("updates.notes.title", { version: release.latestVersion });
  $("updates-notes-text").textContent = release.notes?.trim() || t(dev ? "updates.notes.none-dev" : "updates.notes.none");
}
/* Q55: an update the hand-over could not finish is settled by the next start; say what runs now. */
let lastActivation = null;
let lastActivationRead = null;
function showRestored(last) {
  lastActivation = last;
  const line = $("updates-restored");
  line.hidden = !(last?.kind === "update" && last.state === "failed" && last.fromVersion === state.version);
  line.textContent = line.hidden ? "" : t("updates.outcome.restored", { to: last.toVersion, from: last.fromVersion });
}
document.addEventListener("branch-language", () => {
  if (!window.branchDesktop) return;
  if (lastUpdateStatus) showBuild(lastUpdateStatus);
  showRestored(lastActivation);
});
function showUpdateStatus(status) {
  // The build provenance outcomes arrive as fixed English sentences that the language files also hold.
  $("updates-status").textContent = fromEnglish(status.message) ?? status.message;
  // Show the build provenance sentence persistently once it is known, even as later phases run.
  const provenanceEl = $("updates-provenance");
  if (status.provenance?.message) {
    provenanceEl.textContent = fromEnglish(status.provenance.message) ?? status.provenance.message;
    provenanceEl.hidden = false;
  } else {
    // Hide provenance whenever there is no message (e.g., on retry, or when checking restarts).
    provenanceEl.hidden = true;
  }
  showVersions(status);
  showBuild(status);
  const working = ["checking", "downloading", "verifying", "unpacking", "ready", "applying"].includes(status.phase);
  const installing = ["downloading", "verifying", "unpacking", "ready", "applying"].includes(status.phase);
  if (installing) window.branchUpdateScreen?.show(status); else window.branchUpdateScreen?.hide();
  $("updates-progress").hidden = status.progress === null;
  $("updates-bar").style.width = `${Math.round((status.progress ?? 0) * 100)}%`;
  $("updates-check").disabled = working || status.phase === "unsupported";
  $("updates-install").hidden = status.phase !== "available" && !working;
  $("updates-install").disabled = working;
  $("updates-install").textContent = working ? "Updating…" : "Update and restart";
  clearTimeout(updatesTimer);
  if (working) updatesTimer = setTimeout(() => window.branchDesktop.updateStatus().then(showUpdateStatus).catch(() => {}), installing ? 400 : 700);
}
async function renderUpdates() {
  /* DG-192: the card is on show everywhere, as the sample's is; a browser has the version, not the checking or the channel. */
  for (const id of ["updates-check", "updates-channel", "updates-channel-note"]) $(id).hidden = !window.branchDesktop;
  showVersions(window.branchDesktop ? null : { phase: "unsupported" });
  // An update that did not go through is said on any install, with or without the desktop app.
  void showUpdateFailure();
  void showKeeper();
  if (!window.branchDesktop) return;
  try {
    const channel = (await api("comfort")).values.notify.releaseChannel;
    const choice = document.querySelector(`#updates-channel input[value="${channel}"]`);
    if (choice) choice.checked = true;
  } catch { /* The main-process updater fails closed when owner state is unavailable. */ }
  try { showUpdateStatus(await window.branchDesktop.updateStatus()); } catch (e) { $("updates-status").textContent = e.message; }
  // The record only changes when Branch starts, so it is read once per page, not on every redraw.
  lastActivationRead ??= api("never-break/last-update").then((answer) => answer.last, () => null);
  showRestored(await lastActivationRead);
}
$("updates-channel").addEventListener("change", async (event) => {
  if (event.target?.name !== "release-channel") return;
  try {
    await api("comfort", { card: "notify", values: { releaseChannel: event.target.value } });
    await globalThis.branchComfort?.refresh?.();
    showUpdateStatus(await window.branchDesktop.checkForUpdates());
  } catch (error) {
    toast(error.message);
    await renderUpdates();
  }
});
$("updates-check").addEventListener("click", async () => {
  // Checking again starts over: this attempt's failure is put away (a recorded one still shows).
  failedNow = null;
  void showUpdateFailure();
  try { showUpdateStatus(await window.branchDesktop.checkForUpdates()); } catch (e) { toast(e.message); }
});
/* ---------- tasks working when Update is pressed ---------- */
let busyTimer = null, waitingForTasks = false, installing = false;
/** How many tasks are working now, or null when that could not be found out (never taken as none). */
const whole = (count) => typeof count === "number" && Number.isInteger(count) && count >= 0;
/* Dogfood F4: how many of those are waiting on a fresh question rather than working, for the words; null when not said. */
let busyAsking = null, busyWorking = null;
const busyTasks = () => api("comfort/update-plan", {}).then((plan) => {
  // Only a real count counts: null, false, "" or "3" would each read as a number and could pass for none.
  const count = plan?.busyTasks;
  const known = whole(plan?.workingTasks) && whole(plan?.askingTasks) && plan.workingTasks + plan.askingTasks === count;
  [busyWorking, busyAsking] = known ? [plan.workingTasks, plan.askingTasks] : [null, null];
  return whole(count) ? count : null;
}, () => { busyWorking = busyAsking = null; return null; });
function endBusyChoice() {
  waitingForTasks = false;
  clearTimeout(busyTimer);
  busyTimer = null;
  $("updates-busy").hidden = true;
}
/** Starts the update once, however many presses or answers arrive at the same moment. */
async function installNow() {
  if (installing) return;
  installing = true;
  endBusyChoice();
  try {
    window.branchUpdateScreen?.show({ phase: "downloading", message: "Starting the download…", progress: 0, release: state.updateRelease || null, bytes: null });
    showUpdateStatus(await window.branchDesktop.installUpdate());
  } catch (e) {
    window.branchUpdateScreen?.hide(); toast(e.message);
    // The reason stays on the card: a toast is gone before the owner can read it or tell us.
    failedNow = { version: state.version, why: e.message };
    failureAsked++; // a look already on its way is now out of date
    await renderUpdates();
  }
  finally { installing = false; }
}
/* ---------- an update that did not go through (owner item 19) ---------- */
/* This attempt, when it stopped here; otherwise the journal says whether the last hand-over put the
   version before back. Either way Branch is still on the version it was, and nothing was lost. */
let failedNow = null, failureSaid = null, failureAsked = 0;
function sayFailure(failure) {
  failureSaid = failure;
  const block = $("updates-failed");
  if (!failure) { block.hidden = true; return; }
  $("updates-failed-text").textContent = failure.toVersion
    ? t("updates.failed.to", { to: failure.toVersion, version: state.version })
    : t("updates.failed.now", { version: state.version });
  const why = $("updates-failed-why");
  why.hidden = !failure.why;
  why.textContent = failure.why ? t("updates.failed.why", { why: failure.why }) : "";
  block.hidden = false;
  $("updates-card").hidden = false;
  // Without the desktop app there is nothing to check or install from here: only the failure shows.
  if (!window.branchDesktop) for (const id of ["updates-check", "updates-install"]) $(id).hidden = true;
}
async function showUpdateFailure() {
  // Only the newest look answers: an older one still on its way never hides a failure shown since.
  const asked = ++failureAsked;
  if (failedNow) return sayFailure(failedNow);
  const recorded = await api("updates/failure").then((answer) => answer.failure, () => null);
  if (asked !== failureAsked) return;
  sayFailure(recorded);
}
document.addEventListener("branch-language", () => { if (failureSaid) sayFailure(failureSaid); });
/* ---------- Fix update: the Trunk that looks after updates (owner item 21) ---------- */
/* The report goes to that Trunk's own conversation as the owner's message, through the ordinary
   message box, so what it was given is on screen and it remembers every update it looked at. */
$("updates-failed-fix").addEventListener("click", async () => {
  const button = $("updates-failed-fix");
  // Opening the keeper's conversation would leave a task that is working now without its window.
  if (conversationBusy) { toast(t("updates.fix.busy")); return; }
  button.disabled = true;
  try {
    const fix = await api("updates/fix", {});
    if (fix.trunksSwitchedOn) toast(t("updates.fix.trunks-on", { name: fix.name }));
    else if (fix.made) toast(t("updates.fix.made", { name: fix.name }));
    await openConversation(fix.sessionId);
    $("prompt").value = fix.prompt;
    $("chat-form").requestSubmit();
  } catch (e) { toast(e.message); }
  finally { button.disabled = false; }
});
async function showKeeper() {
  const select = $("updates-keeper");
  const answer = await api("updates/keeper").catch(() => null);
  if (!answer) return;
  select.replaceChildren(select.options[0]);
  for (const trunk of answer.trunks) select.append(new Option(trunk.name, trunk.id));
  select.value = answer.trunkId ?? "";
}
$("updates-keeper").addEventListener("change", async (event) => {
  try { await api("updates/keeper", { trunkId: event.target.value || null }); } catch (e) { toast(e.message); await showKeeper(); }
});
$("updates-failed-log").addEventListener("click", async () => {
  const note = $("updates-failed-saved");
  try {
    const saved = await api("updates/failure-report", {});
    const bytes = Uint8Array.from(atob(saved.base64), (c) => c.charCodeAt(0));
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    link.download = saved.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    note.textContent = t("updates.failed.saved", { name: saved.name });
  } catch (e) { note.textContent = t("updates.failed.not-saved", { why: e.message }); }
});
/* The sentence carries a number, so it is written again on a language change rather than marked with a key. */
let busySaid = null;
function sayBusy(key, count) {
  busySaid = { key, count };
  $("updates-busy-text").textContent = t(key, { count, working: busyWorking ?? 0, asking: busyAsking ?? 0 });
}
const busyKey = (count, waiting) => count === null ? (waiting ? "updates.busy.waiting-unknown" : "updates.busy.unknown")
  : count === 1 ? (waiting ? "updates.busy.waiting-one" : "updates.busy.one") : (waiting ? "updates.busy.waiting-many" : "updates.busy.many");
document.addEventListener("branch-language", () => { if (busySaid && !$("updates-busy").hidden) sayBusy(busySaid.key, busySaid.count); });
let countingForUpdate = false;
$("updates-install").addEventListener("click", async () => {
  // A second press while the first is still counting, installing or asking is the same press.
  if (installing || countingForUpdate || !$("updates-busy").hidden) return;
  countingForUpdate = true;
  const count = await busyTasks().finally(() => { countingForUpdate = false; });
  if (count === 0) return installNow();
  // Nothing closes under a working task without the owner's say, and not knowing counts as maybe:
  // wait for them, or update now and have them offered back.
  // Dogfood F4: a question waiting for the owner is not a task working, and says so.
  const asking = count !== null && busyAsking !== null && busyAsking > 0
    ? (busyWorking > 0 ? "updates.busy.mixed" : count === 1 ? "updates.busy.asking-one" : "updates.busy.asking-many") : null;
  sayBusy(asking ?? busyKey(count, false), count ?? 0);
  $("updates-busy").hidden = false;
});
$("updates-wait").addEventListener("click", () => {
  clearTimeout(busyTimer);
  waitingForTasks = true;
  // One question at a time: the next look is only arranged once this one has an answer.
  const check = async () => {
    if (!waitingForTasks) return;
    const count = await busyTasks();
    if (!waitingForTasks) return;
    if (count === 0) return installNow();
    sayBusy(busyKey(count, true), count ?? 0);
    busyTimer = setTimeout(() => void check(), 3000);
  };
  void check();
});
$("updates-now").addEventListener("click", () => void installNow());
$("updates-busy-cancel").addEventListener("click", () => endBusyChoice());
function modelLine(model) {
  if (!model) return "Model: not recorded";
  const name = model.presetName || model.presetId;
  const fallback = model.fellBackFrom ? ` (after ${model.fellBackFrom} was unavailable)` : "";
  return `Model: ${name} · ${model.model}${fallback}`;
}
/**
 * ci-flakes-3: what each of these lists last said, so the window's refresh every 3 seconds neither
 * rewrites a list that has not changed nor throws away the model somebody has just picked here.
 */
const lastList = new Map();
function presetOptions(select, presets, firstLabel, value) {
  const wanted = [
    ...(firstLabel ? [["", firstLabel]] : []),
    ...presets.map((preset) => [preset.id, `${preset.name} · ${preset.model}${preset.coolingDownUntil ? " (resting)" : ""}`]),
  ];
  const onScreen = select.value;
  const same = JSON.stringify(wanted) === JSON.stringify([...select.options].map((option) => [option.value, option.textContent]));
  if (!same) select.replaceChildren(...wanted.map(([id, words]) => {
    const option = el("option", words);
    option.value = id;
    return option;
  }));
  /* Their own pick, not saved yet, stays — unless what is saved has itself changed since (another
     conversation or project is being shown), which always wins. */
  const before = lastList.get(select.id);
  const theirs = onScreen && before !== undefined && (value ?? "") === before
    && onScreen !== before && wanted.some(([id]) => id === onScreen);
  select.value = theirs ? onScreen : value ?? "";
  lastList.set(select.id, value ?? "");
}
/**
 * mac7/residuals: with a ChatGPT sign-in, a limit passes work down this order; a Codex program in it
 * may be signed in to another of the owner's own ChatGPT plans, which Branch cannot see. Say so.
 */
function codexFallbackNote() {
  const presets = state.models?.presets ?? [];
  const ticked = new Set([...$("models-fallback").querySelectorAll("input:checked")].map((box) => box.value));
  const codex = presets.some((preset) => ticked.has(preset.id) && /:codex$/.test(preset.provider ?? ""));
  $("models-fallback-codex").hidden = !(codex && presets.some((preset) => preset.provider === "chatgpt"));
}
$("models-fallback").addEventListener("change", codexFallbackNote);
function renderModels() {
  const models = state.models;
  if (!models) return;
  presetOptions($("models-active"), models.presets, null, models.activePreset ?? models.defaultPreset);
  if (document.activeElement !== $("models-reasoning")) $("models-reasoning").value = models.reasoning ?? "";
  if (document.activeElement !== $("models-cooldown")) $("models-cooldown").value = Math.round(models.cooldownMs / 1000);
  const fallback = $("models-fallback");
  if (!fallback.contains(document.activeElement)) {
    fallback.replaceChildren(...models.presets.map((preset) => {
      const label = el("label", undefined, "check");
      const box = document.createElement("input");
      box.type = "checkbox"; box.value = preset.id;
      box.checked = models.fallbackOrder.includes(preset.id);
      label.append(box, ` ${preset.name} · ${preset.model}`);
      return label;
    }));
  }
  codexFallbackNote();
  // Integration review (mac7/wake-pins): the checkboxes above are new nodes with no
  // aria-describedby. Describe them now rather than leaving them bare until the debounce runs.
  globalThis.branchDescribeSettingsNow?.();
  $("models-note").textContent = models.presets.length > 1
    ? `${models.presets.length} models available.`
    : "One model is configured. Add more with BRANCH_MODEL_PRESETS in the launch environment, or in the desktop connection settings.";
  presetOptions($("session-model"), models.presets, "Workspace default", sessionModel.preset);
  // phase2/accounts: the Thinking lists offer only what the model takes (public/thinking-levels.js).
  globalThis.branchModelsNow = models;
  document.dispatchEvent(new CustomEvent("branch-models", { detail: models }));
}
/* The page's own rebuild of the model controls, so a test can watch what a rebuild leaves behind. */
globalThis.branchRenderModels = () => renderModels();
let sessionModel = { preset: null, reasoning: null };
async function loadSessionSkill() {
  const select = $("session-skill");
  const enabled = (state.skills || []).filter((skill) => skill.activeVersion);
  const current = sessionId ? (await api(`sessions/${sessionId}/skill`).catch(() => ({ skillId: null }))).skillId : null;
  select.replaceChildren(el("option", "None"), ...enabled.map((skill) => { const option = el("option", skill.name); option.value = skill.id; return option; }));
  select.options[0].value = "";
  select.value = current ?? "";
}
$("session-skill").addEventListener("change", async () => {
  if (!sessionId) return;
  try { await api(`sessions/${sessionId}/skill`, { skillId: $("session-skill").value || null }); toast($("session-skill").value ? "Skill pinned to this conversation." : "Skill unpinned."); }
  catch (e) { toast(e.message); }
});
async function loadSessionModel() {
  $("model-controls").hidden = !sessionId;
  if (!sessionId) return;
  await loadSessionSkill();
  const value = await api(`sessions/${sessionId}/model`);
  sessionModel = value;
  presetOptions($("session-model"), state.models?.presets ?? [], "Workspace default", value.preset);
  $("session-reasoning").value = value.reasoning ?? "";
  $("model-used").textContent = `Next reply: ${value.effective.presetName} · ${value.effective.model}`;
  document.dispatchEvent(new CustomEvent("branch-session-model", { detail: value })); // phase2/accounts
}
async function saveSessionModel() {
  if (!sessionId) return;
  try {
    await api(`sessions/${sessionId}/model`, {
      preset: $("session-model").value || null,
      reasoning: $("session-reasoning").value || null,
    });
    await loadSessionModel();
  } catch (e) { toast(e.message); }
}
/* Wave 7: the rail shows the active model again after /model or the models.switch tool. */
globalThis.branchRefreshSessionModel = () => loadSessionModel();
$("session-model").addEventListener("change", saveSessionModel);
$("session-reasoning").addEventListener("change", saveSessionModel);
form("models-form", async () => {
  const fallbackOrder = [...$("models-fallback").querySelectorAll("input:checked")].map((box) => box.value);
  await api("models", {
    activePreset: $("models-active").value || null,
    reasoning: $("models-reasoning").value || null,
    fallbackOrder,
    cooldownMs: Math.max(0, Math.round(Number($("models-cooldown").value) || 0)) * 1000,
  });
  await refresh();
});
function renderSkills() {
  if (document.activeElement !== $("skill-policy")) $("skill-policy").value = state.skillPolicy || "block";
  const names = new Map((state.skills || []).map((s) => [s.id, s.name]));
  list("set-aside-list", state.setAside || [], (x) => {
    const node = el("div", undefined, "record");
    node.append(el("strong", names.get(x.skillId) || x.skillId), el("p", `Kept failing: ${x.signature} · trial after ${date(x.until)}${x.trialRunId ? " · a trial is under way" : ""}`, "meta"),
      button("Let it back in now", async () => { await api(`governance/set-aside/${x.skillId}/restore`, {}); await refresh(); }));
    return node;
  }, ["No skill is set aside.", "If a skill keeps going wrong in the same way it is rested here for a while. Nothing has needed that yet."]);
  list("skills-list", state.skills || [], value => {
    const node = recordCard(value.name, value.needsReview ? "needs your review" : value.activeVersion === null ? "disabled" : "enabled");
    node.dataset.skillId = value.id;
    node.append(el("p", value.description), el("p", `Latest v${value.headVersion} · ${value.activeVersion === null ? "No active version" : `Active v${value.activeVersion}: ${value.activeName}`}`, "meta"));
    const open = button("Open skill", () => skillOperation(async () => {
      selectSkill(await api("skills/" + value.id));
    }));
    open.disabled = skillBusy; node.append(open); return node;
  }, ["No skills yet.", "A skill is a page of instructions your assistant can follow. Write one below, or open a file someone sent you."]);
}
function selectSkill(value) {
  skillView = value;
  $("skill-editor-title").textContent = value ? value.name : "Install a skill";
  $("skill-document").value = value?.document ?? "---\nname: my-skill\ndescription: Describe when this skill should be used.\n---\n\nWrite the skill instructions here.\n";
  $("skill-save").textContent = value ? "Save new version" : "Install skill";
  $("skill-reload").hidden = !value; $("skill-version-controls").hidden = !value;
  $("skill-version").replaceChildren(...(value?.versions || []).map(item => {
    const option = el("option", `v${item.version}: ${item.name}`); option.value = item.version; return option;
  }));
  if (value) $("skill-version").value = value.activeVersion ?? value.headVersion;
  renderSkillFindings();
}
function renderSkillFindings() {
  const version = skillView?.versions?.find((item) => String(item.version) === String($("skill-version").value));
  const findings = version?.findings || [];
  list("skill-findings", findings, (finding) => {
    const node = el("div", undefined, "record");
    node.append(el("strong", `Line ${finding.line}: ${finding.reason}`), el("p", finding.excerpt, "meta"));
    return node;
  }, "");
  $("skill-findings").hidden = !findings.length;
  $("skill-acknowledge-row").hidden = !findings.length;
  $("skill-acknowledge").checked = false;
}
$("skill-version").addEventListener("change", renderSkillFindings);
$("skill-policy").addEventListener("change", async () => {
  try { await api("skills/policy", { policy: $("skill-policy").value }); toast($("skill-policy").value === "block" ? "Risky skills are blocked." : "Risky skills wait for your review."); }
  catch (e) { toast(e.message); }
});
async function skillOperation(work) {
  if (skillBusy) return;
  skillBusy = true; setSkillControls(true); $("skill-status").textContent = "Working…";
  try { await work(); $("skill-status").textContent = "Skill changes ready."; }
  catch (error) { $("skill-status").textContent = error.message; }
  finally { skillBusy = false; setSkillControls(false); }
}
function setSkillControls(disabled) {
  $("skills").querySelectorAll("button,input,textarea,select").forEach(node => { node.disabled = disabled; });
}
async function mutateSkill(operation, extra = {}) {
  if (!skillView) return;
  const draft = $("skill-document").value;
  const result = await api(`skills/${skillView.id}/${operation}`, { expectedRevision: skillView.revision, ...extra });
  selectSkill(operation === "remove" ? null : result);
  if (operation === "activate" || operation === "disable") $("skill-document").value = draft;
  await refresh();
}
$("skill-form").addEventListener("submit", event => {
  event.preventDefault(); void skillOperation(async () => {
    const document = $("skill-document").value;
    if (document.length > 16000 || new TextEncoder().encode(document).length > 48 * 1024)
      throw new Error("SKILL.md must be at most 16,000 characters and 48 KiB.");
    if (skillView) await mutateSkill("update", { document });
    else { selectSkill(await api("skills/install", { document })); await refresh(); }
  });
});
$("skill-new").onclick = () => { if (!skillBusy) { selectSkill(null); $("skill-status").textContent = "New skill draft."; } };
$("skill-reload").onclick = () => { void skillOperation(async () => { if (skillView) selectSkill(await api("skills/" + skillView.id)); }); };
$("skill-import-button").onclick = () => { if (!skillBusy) $("skill-import").click(); };
$("skill-import").onchange = () => {
  const file = $("skill-import").files[0]; $("skill-import").value = "";
  if (file) void skillOperation(async () => {
    if (file.size > 48 * 1024) throw new Error("SKILL.md must be at most 48 KiB.");
    const document = await file.text();
    if (document.length > 16000) throw new Error("SKILL.md must be at most 16,000 characters.");
    selectSkill(null); $("skill-document").value = document;
  });
};
$("skill-read").onclick = () => { void skillOperation(async () => {
  if (skillView) $("skill-document").value = (await api(`skills/${skillView.id}/read`, { version: Number($("skill-version").value) })).document;
}); };
for (const operation of ["activate", "disable", "remove"]) $("skill-" + operation).onclick = () => {
  void skillOperation(() => mutateSkill(operation, operation === "activate" ? { version: Number($("skill-version").value), acknowledge: $("skill-acknowledge").checked } : {}));
};
selectSkill(null);
function renderIdentity() {
  document.title = `${state.identity?.name || "Branch Agent"} — Your personal assistant`;
  if (identityDirty || identityBusy || !state.identity) return;
  if (identityDraft && state.identity.revision < identityDraft.revision) return;
  setIdentityDraft(state.identity);
}
function setIdentityDraft(identity) {
  identityDraft = { ...identity }; identityDirty = false;
  $("identity-name").value = identity.name;
  $("identity-instructions").value = identity.instructions;
}
async function changeIdentity(reload) {
  if (identityBusy || !identityDraft) return;
  identityBusy = true; $("identity-fields").disabled = true;
  $("identity-status").textContent = reload ? "Reloading saved identity…" : "Saving identity…";
  try {
    const saved = reload ? (await api("state")).identity : await api("identity", {
      name: identityDraft.name, instructions: identityDraft.instructions, expectedRevision: identityDraft.revision,
    });
    setIdentityDraft(saved);
    $("identity-status").textContent = reload ? "Saved identity loaded." : "Identity saved. Changes apply to the next task.";
  } catch (error) { $("identity-status").textContent = error.message; }
  finally { identityBusy = false; $("identity-fields").disabled = false; }
}
$("identity-form").addEventListener("submit", event => { event.preventDefault(); void changeIdentity(false); });
$("identity-reload").addEventListener("click", () => { void changeIdentity(true); });
for (const [id, key] of [["identity-name", "name"], ["identity-instructions", "instructions"]]) {
  $(id).addEventListener("input", () => {
    if (!identityBusy && identityDraft) { identityDraft[key] = $(id).value; identityDirty = true; }
  });
}
/** Plain language for one tool call, so the step row reads like a sentence. */
function stepLabel(calls) {
  const names = [...new Set(calls.map((call) => call.name.replace(/[._]/g, " ")))];
  const shown = names.slice(0, 3).join(", ");
  return calls.length === 1 ? `Used ${shown}` : `Worked with ${calls.length} tools · ${shown}`;
}
/** A tool step is one quiet row in the flow that opens, not a card of its own. */
function toolStep(content, calls, source) {
  const node = el("details", undefined, "message assistant-step tool-step");
  const summary = el("summary");
  summary.append(el("span", stepLabel(calls)));
  // Wave 6: the row that says what it worked with also opens the whole task.
  if (source?.runId && globalThis.branchInspector) summary.append(globalThis.branchInspector.button(source.runId));
  node.append(summary);
  const body = el("div", undefined, "step-body");
  if (content.trim()) body.append(el("p", content));
  for (const call of calls) {
    const line = el("div", undefined, "step-line");
    line.append(el("strong", call.name), el("span", call.arguments.slice(0, 160)));
    body.append(line);
  }
  node.append(body);
  $("conversation").append(node);
}
/** How big a kept file is, in words a person reads rather than bytes. */
const fileSize = (bytes) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
/** The safe kinds shown in the page itself; everything else is offered as a download. */
const playableHere = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif",
  "audio/wav", "audio/mpeg", "audio/ogg", "audio/webm", "audio/mp4",
  "video/mp4", "video/webm", "video/ogg",
]);
/** Asks for a kept file with the window's own key, and hands back something the page can point at. */
async function keptFileUrl(ref) {
  const answer = await fetch(
    `/api/attachments/file?session=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(ref.id)}`,
    { headers: { authorization: "Bearer " + (sessionStorage.getItem("branch-token") || "") } });
  if (!answer.ok) throw new Error("That file could not be opened");
  return URL.createObjectURL(await answer.blob());
}
/**
 * A card for each file that came with a message: what it is called, how big it is, and one control —
 * Show it here for a picture, a sound or a film, and Download for everything else. The bytes are
 * fetched with the window's key, so nothing is readable from an address alone.
 */
function attachedFiles(refs) {
  const row = el("div", undefined, "message-files");
  for (const ref of refs) {
    const card = el("div", undefined, "message-file");
    card.dataset.attachment = ref.id;
    card.append(el("span", ref.name, "message-file-name"));
    card.append(el("span", `${ref.kind} · ${fileSize(ref.bytes)}`, "meta"));
    const shown = el("div", undefined, "message-file-shown");
    const open = button(playableHere.has(ref.mediaType) ? "Show it here" : "Download", async () => {
      open.disabled = true;
      try {
        const url = await keptFileUrl(ref);
        if (!playableHere.has(ref.mediaType)) {
          const save = Object.assign(document.createElement("a"), { href: url, download: ref.name });
          document.body.append(save);
          save.click();
          save.remove();
          setTimeout(() => URL.revokeObjectURL(url), 30000);
          return;
        }
        const tag = ref.kind === "picture" ? "img" : ref.kind === "sound" ? "audio" : "video";
        const media = Object.assign(document.createElement(tag), { src: url });
        if (tag !== "img") media.controls = true;
        else media.alt = ref.name;
        shown.replaceChildren(media);
      } catch (error) { toast(error.message); open.disabled = false; }
    });
    open.classList.add("text-button");
    card.append(open, shown);
    row.append(card);
  }
  return row;
}
function message(role, content, source) {
  if (source?.toolCalls?.length) return toolStep(content, source.toolCalls, source);
  const node = el("div", undefined, "message " + role);
  /* Wave 8 (A1940): a reply a specialist gave is signed with that specialist's own name, so a
     conversation with several of them says plainly which one said what. */
  const author = role === "user" ? "You" : source?.author || state.identity?.name || "Branch Agent";
  const by = el("small", author);
  if (role === "assistant" && source?.author) by.classList.add("message-specialist");
  node.append(by);
  /* Replies are written in markdown; what you typed is shown exactly as you typed it. */
  if (role === "user") {
    node.append(document.createTextNode(content));
    // FQ-surfaces.playback: a sound or video file attached to this message plays inline, right here,
    // both the moment it is sent and every time the conversation is redrawn afterwards.
    globalThis.branchPlaybackRender?.(node, sessionId, source);
  }
  else node.append(fillMarkdown(el("div", undefined, "message-body"), content));
  /* The files that came with this message, shown whenever the conversation is read — including after
     it is reopened, which is the whole point of keeping them (src/attachments.ts). The cards are
     appended on their own: what was said is decided by who said it, and never by whether a file
     came with it. */
  if (source?.attachments?.length) node.append(attachedFiles(source.attachments));
  /* Wave 7: every reply gets Read aloud, whether or not it can also be branched from, and it goes
     through the voice service so the free Windows voice works with no key and no internet. */
  if (role === "assistant" && !source?.toolCalls?.length) {
    const controls = el("div", undefined, "message-controls");
    controls.append(copyButton(content));
    if (source?.messageId)
      controls.append(conversationButton("Branch from here", () => branchConversation(sessionId, source.messageId)));
    const readBtn = button("Read aloud", () => globalThis.branchSpeak?.(content));
    readBtn.classList.add("text-button");
    const stopBtn = button("Stop", () => globalThis.branchStopSpeaking?.());
    stopBtn.classList.add("text-button");
    controls.append(readBtn, stopBtn);
    node.append(controls);
  } else {
    // Dogfood B8: every message can be copied, what was typed as much as what came back.
    const controls = el("div", undefined, "message-controls");
    controls.append(copyButton(content));
    if (source?.messageId) controls.append(conversationButton("Branch from here", () => branchConversation(sessionId, source.messageId)));
    node.append(controls);
  }
  $("conversation").append(node);
}
/**
 * Dogfood B8: copies one message as it was written (an answer's markdown, or exactly what was typed). The page's
 * clipboard is tried first; a window that refuses it (no focus, an older engine) gets the selection's copy instead.
 */
function copyButton(content) {
  const node = button(t("message.copy"), async () => {
    const text = String(content ?? "");
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; }
    catch {
      const spare = el("textarea");
      spare.value = text;
      spare.setAttribute("readonly", "");
      spare.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.append(spare);
      spare.select();
      try { copied = document.execCommand("copy"); } catch { copied = false; }
      spare.remove();
    }
    toast(copied ? t("message.copied") : t("message.copyFailed"));
  });
  node.classList.add("text-button", "message-copy");
  node.dataset.t = "message.copy";
  return node;
}
function conversationButton(label, handler) {
  const node = button(label, async () => {
    if (conversationBusy) return;
    setConversationBusy(true);
    try { await handler(); } finally { setConversationBusy(false); }
  });
  node.classList.add("conversation-switch", "text-button");
  node.disabled = conversationBusy;
  return node;
}
let pendingFollowUps = 0;
/** A message typed while the assistant is busy waits its turn in the same conversation. */
/** Q58: the reply to a message that waits its turn, in the owner's language. */
function queuedReply(position) {
  if (position <= 1) return t("queue.reply.next");
  return position === 2 ? t("queue.reply.afterOne") : t("queue.reply.afterMany", { n: position - 1 });
}
async function queueFollowUp(prompt) {
  try {
    // r17-h: wait, pass it on, or stop and go next, as the owner chose (public/flows-boards.js); null keeps the plain queue.
    const busy = await globalThis.branchBusySend?.(sessionId, prompt);
    const result = busy ?? await api(`sessions/${sessionId}/followups`, { prompt });
    $("prompt").value = "";
    message("user", prompt);
    message("assistant", busy && busy.mode !== "queue" ? busy.message : queuedReply(result.position));
    if (busy?.mode === "steer") return;
    pendingFollowUps++;
  } catch (e) { toast(e.message); }
}
/** After the main task ends, keeps the conversation fresh until every queued message has been answered. */
async function awaitFollowUps() {
  const session = sessionId;
  for (let i = 0; i < 400 && pendingFollowUps > 0 && sessionId === session; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const running = await api("activity");
      const mine = running.find((r) => r.sessionId === session);
      const waiting = mine ? mine.followUps : (await api(`sessions/${session}/followups`)).followUps.length;
      if (!mine && waiting === 0) { pendingFollowUps = 0; await loadConversation(session); await refresh(); }
    } catch { /* the next tick tries again */ }
  }
}
$("followup-send").addEventListener("click", async () => {
  const prompt = $("prompt").value.trim();
  if (prompt && conversationBusy && sessionId) await queueFollowUp(prompt);
});
function setConversationBusy(busy) {
  conversationBusy = busy;
  $("send").disabled = busy;
  $("followup-send").hidden = !(busy && sessionId);
  // A follow-up message carries words only, so pictures cannot be attached while a task is working.
  $("composer-media").disabled = busy;
  $("new-session").disabled = busy;
  if ($("conversation-import")) $("conversation-import").disabled = busy;
  document.querySelectorAll(".conversation-switch").forEach(node => { node.disabled = busy; });
}
function selectConversation(id, branch = null, imported = false) {
  sessionId = id;
  currentBranch = branch;
  currentImported = imported;
  $("conversation").dataset.sessionId = id || "";
  $("session-label").textContent = branch ? "Branched conversation" : imported ? "Imported conversation" : "Saved conversation";
  if (savedHistoryDialog?.open) savedHistoryDialog.close();
  displayView("chat");
  renderConversationContext();
}
function renderConversationContext() {
  const context = $("session-context");
  context.replaceChildren();
  context.hidden = !sessionId;
  /* The calm window shows this row only for a copied or imported conversation (public/layout.css). */
  context.dataset.kind = currentBranch ? "branch" : currentImported ? "imported" : "plain";
  if (!sessionId) return;
  context.append(el("p", currentBranch
    ? "Conversation copied through the selected message. This branch shares workspace files and saved memory."
    : "Workspace files and saved memory are shared across conversations."));
  if (currentImported) context.append(el("p", "Imported messages are untrusted history. Importing never runs saved tool calls."));
  if (currentBranch) {
    const original = currentBranch.parentSessionId;
    context.append(conversationButton("Open original conversation", () => openConversation(original)));
  }
  if (!currentTemporary) context.append(conversationButton("Forget what this conversation saved to memory", () => previewForget(context)));
  if (!currentTemporary) void renderMemoryPolicy(context);
  void renderChatLink(context);
}
/** Lets a Telegram chat continue this very conversation, so both see the same history. */
async function renderChatLink(context) {
  let summary;
  try { summary = await api("channels"); } catch { return; }
  if (!summary.chats.length) return;
  const row = el("div", undefined, "check-row");
  const select = el("select");
  select.append(el("option", "Link a chat to this conversation…"));
  for (const chat of summary.chats) { const option = el("option", `${chat.channel}: ${chat.title}${chat.sessionId === sessionId ? " (linked)" : ""}`); option.value = JSON.stringify({ channel: chat.channel, chatId: chat.chatId }); select.append(option); }
  select.addEventListener("change", async () => {
    if (!select.value) return;
    try { await api("channels/link", { ...JSON.parse(select.value), sessionId }); toast("That chat now continues this conversation."); renderConversationContext(); }
    catch (e) { toast(e.message); }
  });
  row.append(select);
  context.append(row);
}
/** A switch for whether this conversation may save memory on its own. */
async function renderMemoryPolicy(context) {
  let policy;
  try { policy = await api(`sessions/${sessionId}/memory-policy`); } catch { return; }
  const row = el("label", undefined, "check-row");
  const box = el("input"); box.type = "checkbox"; box.checked = policy.remember;
  row.append(box, document.createTextNode(" This conversation may save things to memory on its own"));
  box.addEventListener("change", async () => {
    try { await api(`sessions/${sessionId}/memory-policy`, { remember: box.checked }); toast(box.checked ? "It may remember from here again." : "It will not remember from this conversation on its own."); }
    catch (e) { toast(e.message); box.checked = !box.checked; }
  });
  context.append(row);
}
async function previewForget(context) {
  let preview;
  try { preview = await api("memory/forget/preview", { sessionId }); } catch (e) { toast(e.message); return; }
  const panel = el("div", undefined, "forget-panel");
  if (!preview.remove.length && !preview.excluded.length) {
    panel.append(el("p", preview.suppressed
      ? "Nothing saved from here, and this conversation no longer saves memory on its own."
      : "This conversation has not saved anything to memory."));
  } else {
    if (preview.remove.length) {
      panel.append(el("p", `${preview.remove.length} saved ${preview.remove.length === 1 ? "fact" : "facts"} will be removed:`));
      const list = document.createElement("ul");
      for (const entry of preview.remove) list.append(el("li", entry.text));
      panel.append(list);
    }
    if (preview.excluded.length) {
      panel.append(el("p", `${preview.excluded.length} kept because you edited ${preview.excluded.length === 1 ? "it" : "them"}:`));
      const kept = document.createElement("ul");
      for (const entry of preview.excluded) kept.append(el("li", `${entry.text} — ${entry.reason}`));
      panel.append(kept);
    }
    panel.append(el("p", "Afterwards this conversation will not save memory on its own again.", "subtle"));
    if (preview.remove.length || !preview.suppressed)
      panel.append(conversationButton("Forget them", async () => {
        try {
          const result = await api("memory/forget", { sessionId });
          toast(result.problem ? `Removed ${result.removed} from memory. ${result.problem}` : `Removed ${result.removed} from memory.`);
          await refresh(); renderConversationContext();
        } catch (e) { toast(e.message); }
      }));
  }
  context.append(panel);
}
function renderConversation(value, status) {
  selectConversation(value.sessionId, value.branch, value.imported);
  $("conversation").replaceChildren();
  const first = value.messages.find((entry) => entry.role === "user");
  $("thread-name").textContent = first ? first.content.slice(0, 70) : "";
  /* Wave 8 (A1940): a message the owner put to a specialist was sent with that specialist's
     number in front of it, so on the way back the reply can be signed with its name again and
     what the owner typed can be shown without the machinery. */
  let answering = null;
  for (const source of value.messages) {
    if (!["user", "assistant"].includes(source.role)) continue;
    if (source.role === "user") {
      const asked = delegationIn(source.content);
      answering = asked.specialist;
      message("user", asked.text, source);
      continue;
    }
    message("assistant", source.content, answering ? { ...source, author: answering } : source);
  }
  if (status) $("session-label").textContent = status + (value.branch ? " · branched conversation" : value.imported ? " · imported conversation" : " · conversation saved");
}
async function loadConversation(id, status) {
  try {
    renderConversation(await api("sessions/" + id), status);
    await loadSessionModel();
  } catch (error) {
    renderConversationContext();
    $("thread-name").textContent = "";
    const context = $("session-context");
    context.hidden = false;
    context.append(el("p", "The conversation is saved, but its messages could not be loaded. New messages will continue this saved conversation. You can retry opening it."),
      conversationButton("Retry opening conversation", () => openConversation(id)));
    toast(error.message);
  }
}
async function openConversation(id) {
  currentTemporary = false;
  $("temporary-toggle").checked = false;
  $("temporary-toggle").disabled = true;
  const value = await api("sessions/" + id);
  renderConversation(value);
}
async function branchConversation(original, messageId) {
  const branch = await api("action", { tool: "sessions.branch", args: { sessionId: original, messageId } });
  selectConversation(branch.sessionId, branch);
  $("conversation").replaceChildren();
  await loadConversation(branch.sessionId);
}
function savedConversationCard(value) {
  const card = recordCard(value.preview || "Empty conversation");
  card.dataset.sessionId = value.sessionId;
  const controls = el("div", undefined, "saved-actions");
  controls.append(conversationButton("Open", () => openConversation(value.sessionId)),
    conversationButton("Duplicate", () => duplicateConversation(value.sessionId)),
    conversationButton("Export JSON", () => exportConversation(value.sessionId)));
  card.append(el("p", `${value.messageCount} messages · ${date(value.createdAt)}`, "meta"), controls);
  return card;
}
async function searchSavedConversations(offset = 0) {
  const revision = ++savedSearchRevision;
  const query = offset ? savedQuery : $("saved-query").value;
  $("saved-search").disabled = true; $("saved-more").disabled = true;
  try {
    const value = await api("sessions/search", { query, offset });
    if (revision !== savedSearchRevision) return;
    if (!offset) $("saved-list").replaceChildren();
    $("saved-list").append(...value.sessions.map(savedConversationCard));
    if (!$("saved-list").children.length) $("saved-list").append(el("p", "No saved conversations match this search."));
    savedNextOffset = value.nextOffset;
    savedQuery = query;
    $("saved-more").hidden = savedNextOffset === null;
  } catch (error) { toast(error.message); }
  finally {
    if (revision === savedSearchRevision) { $("saved-search").disabled = false; $("saved-more").disabled = false; }
  }
}
async function openCreatedConversation(result, imported = false) {
  selectConversation(result.sessionId, null, imported);
  if (!imported) $("session-label").textContent = "Copied conversation";
  $("conversation").replaceChildren();
  await loadConversation(result.sessionId);
}
async function duplicateConversation(id) {
  const result = await api("sessions/" + id + "/duplicate", {});
  await openCreatedConversation(result);
}
async function exportConversation(id) {
  const archive = await api("sessions/" + id + "/export");
  if (await exportArchive(archive, "exportConversation", `branch-conversation-${id}.json`)) toast("Conversation exported.");
}
async function exportArchive(archive, method, filename) {
  const text = JSON.stringify(archive);
  if (desktop && !window.branchDesktop?.[method])
    throw new Error("Desktop export is unavailable. Reopen Branch Agent and try again.");
  if (window.branchDesktop?.[method]) {
    if (!(await window.branchDesktop[method](text)).saved) return false;
  } else {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = el("a"); link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return true;
}
async function importConversation(file) {
  if (file.size > 4 * 1024 * 1024) throw new Error("Conversation archives must be at most 4 MiB.");
  let archive;
  try { archive = JSON.parse(await file.text()); }
  catch { throw new Error("Choose a valid conversation JSON file."); }
  const result = await api("sessions/import", archive);
  await openCreatedConversation(result, true);
}
async function handleConversationImport() {
  const file = $("conversation-import").files[0]; $("conversation-import").value = "";
  if (!file || conversationBusy) return;
  setConversationBusy(true);
  try { await importConversation(file); } catch (error) { toast(error.message); }
  finally { setConversationBusy(false); }
}
function createSavedHistoryDialog() {
  const dialog = el("dialog");
  dialog.id = "saved-history-dialog";
  dialog.className = "saved-history-dialog";
  dialog.setAttribute("aria-labelledby", "saved-history-title");
  dialog.append($("saved-history-template").content.cloneNode(true));
  document.body.append(dialog);
  if (t("history.title") !== "history.title") applyLanguage(dialog);
  $("saved-history-close").addEventListener("click", () => dialog.close());
  $("saved-search-form").addEventListener("submit", event => {
    event.preventDefault(); void searchSavedConversations();
  });
  $("saved-more").addEventListener("click", () => {
    if (savedNextOffset !== null) void searchSavedConversations(savedNextOffset);
  });
  $("import-conversation").addEventListener("click", () => {
    if (!conversationBusy) $("conversation-import").click();
  });
  $("conversation-import").addEventListener("change", handleConversationImport);
  $("conversation-import").disabled = conversationBusy;
  $("import-conversation").disabled = conversationBusy;
  return dialog;
}
export function openSavedConversations() {
  savedHistoryDialog ??= createSavedHistoryDialog();
  if (!savedHistoryDialog.open) savedHistoryDialog.showModal();
  $("saved-history-status").textContent = "";
  $("saved-query").focus();
  void searchSavedConversations();
}
document.addEventListener("branch-profile", () => {
  savedSearchRevision++;
  savedQuery = "";
  savedNextOffset = null;
  if (!savedHistoryDialog) return;
  if (savedHistoryDialog.open) savedHistoryDialog.close();
  $("saved-query").value = "";
  $("saved-list").replaceChildren();
  $("saved-history-status").textContent = "";
});
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  token = $("token").value.trim();
  /* Kept before the workspace shows, not after: a reload in the gap used to find no token and put the
     sign-in form back over a session that had just connected, and the parts that draw themselves the
     moment it shows (Recents, the Lockdown switch) read it from here. Put back if the token is refused. */
  const kept = sessionStorage.getItem("branch-token");
  sessionStorage.setItem("branch-token", token);
  try {
    try { await refresh(); }
    catch (error) {
      if (kept === null) sessionStorage.removeItem("branch-token"); else sessionStorage.setItem("branch-token", kept);
      throw error;
    }
    // Signing back in is what unlocks the secrets locker again.
    await api("lock/unlock", {}).catch(() => undefined);
    $("token").value = "";
    /* Wave 7: the voice and model-routing cards can only read their settings once you are in. */
    globalThis.branchVoiceReady?.();
    /* Wave 9: the owner's own instruction files can only be read once you are in, same as above. */
    globalThis.branchContextFilesReady?.();
    globalThis.branchHeartbeatReady?.();
    /* mac3/security-check: the security check card reads its switches once you are in. */
    globalThis.branchSecurityCheckReady?.();
    globalThis.branchLearningCoreReady?.(); // mac2/fly-core-2
    globalThis.branchPeopleReady?.(); // bucket 19: who may sign in from other devices
    globalThis.branchSettingsKitReady?.(); // R17-S-A: presets, putting settings back, the settings file
  } catch (e) {
    toast(e.message);
  }
});
$("lock").addEventListener("click", () => {
  // Also tell the assistant itself: while it is locked it will not open the secrets locker.
  api("lock", {}).catch(() => undefined);
  token = "";
  sessionStorage.removeItem("branch-token");
  $("workspace").hidden = true;
  $("login").hidden = false;
  $("lock").hidden = true;
  $("connection").textContent = "Locked";
  $("connection").dataset.state = "locked";
});
/** Enter sends; Shift+Enter (or Ctrl/Cmd+Enter while busy) keeps typing on a new line, like most chat apps. */
$("prompt").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
  if (event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (conversationBusy && sessionId) { $("followup-send").click(); return; }
  if (!conversationBusy) $("chat-form").requestSubmit();
});
/**
 * Wave 7: lines you type that are commands rather than messages. Wave mac3: the list is no longer
 * written here — it is read from the one table every surface shares (src/commands/catalog.ts,
 * served at /api/commands), so the message box offers exactly what that table says the window
 * does. Each row is [name, description, details]. "/model" and "/help" still work when
 * public/model-profiles.js and public/commands.js have not loaded; when they have, they handle the
 * rest. Returns true when the line was a command, so nothing is sent to the model.
 */
export const SLASH_COMMANDS = [];
let slashList = null;
/* The phone app opens the paired Branch at "/" and leaves a note in this tab first (apps/mobile inject.js). */
const phoneNote = () => { try { return Boolean(sessionStorage.getItem("branch-phone")); } catch { return false; } };
const slashSurface = () => (globalThis.Capacitor?.isNativePlatform?.() || phoneNote()
  || new URLSearchParams(location.search).get("surface") === "phone" ? "phone" : "window");
export function loadSlashCommands(fresh = false) {
  if (slashList && !fresh) return slashList;
  slashList = api(`commands?surface=${slashSurface()}`).then(({ commands, mode }) => {
    const others = SLASH_COMMANDS.filter((row) => !row[2]);
    SLASH_COMMANDS.splice(0, SLASH_COMMANDS.length, ...commands.map((entry) => [`/${entry.name}`, t(entry.key) === entry.key ? entry.english : t(entry.key), { ...entry, mode }]),
      ...others.filter(([name]) => !commands.some((entry) => `/${entry.name}` === name)));
    return SLASH_COMMANDS;
  }).catch(() => { slashList = null; return SLASH_COMMANDS; });
  return slashList;
}
globalThis.branchSlashCommands = { list: SLASH_COMMANDS, load: loadSlashCommands, surface: slashSurface };
export function parseSlashCommand(line) {
  const match = /^\/([a-z?][\w?-]*)(?:\s+([\s\S]*))?$/i.exec(String(line ?? "").trim());
  if (!match) return null;
  const typed = match[1].toLowerCase();
  const row = SLASH_COMMANDS.find(([known, , details]) => known === "/" + typed || details?.aliases?.includes(typed));
  if (!row) return null;
  return { name: row[0], rest: (match[2] ?? "").trim() };
}
/** The /help list: what the table says this window lists. */
const slashHelp = () => "Commands you can type here:\n" + SLASH_COMMANDS
  .filter(([, , details]) => !details || details.listed)
  .map(([name, what, details]) => `${name}${details?.args ? " " + details.args : ""} — ${what}`).join("\n");
async function runSlashCommand(typed) {
  if (!typed.startsWith("/")) return false;
  await loadSlashCommands();
  const command = parseSlashCommand(typed);
  if (!command) return false;
  if (command.name === "/help" && !command.rest) {
    toast(slashHelp());
    return true;
  }
  /* "/model" is the models module's when it is there, and this file's own otherwise; the shared
     commands (public/commands.js) handle the rest. */
  if (command.name === "/model") {
    if (globalThis.branchSlashCommand) return (await globalThis.branchSlashCommand(typed, sessionId)) !== false;
    await switchModelWithoutModule(command.rest);
    return true;
  }
  if (globalThis.branchCatalogCommand) return (await globalThis.branchCatalogCommand(typed, sessionId)) !== false;
  return false;
}
/** The plain fallback for "/model": list the choices, or change this conversation's model. */
async function switchModelWithoutModule(wanted) {
  try {
    if (!wanted || wanted === "?") {
      const { active, choices } = await api("models/switch");
      toast("Type /model followed by a name:\n" + choices
        .map((choice) => `${choice.id === active ? "→ " : "  "}${choice.name} (${choice.model})`).join("\n"));
      return;
    }
    if (!sessionId) { toast("Start a conversation first, then /model changes the model for it."); return; }
    toast((await api("models/switch", { sessionId, model: wanted })).message);
    await globalThis.branchRefreshSessionModel?.();
  } catch (error) { toast(error.message); }
}
/**
 * Wave 7: talk mode. The words that were spoken are sent the ordinary way, and the reply comes
 * back so it can be read aloud. Nothing here bypasses the message box: you see what was heard.
 */
let lastReply = "";
globalThis.branchRunSpoken = async (text) => {
  if (conversationBusy) return "";
  lastReply = "";
  $("prompt").value = text;
  $("chat-form").requestSubmit();
  // Waits for the task to finish, however it finishes. A task that fails leaves no reply to read
  // out, so this comes straight back rather than leaving talk mode stuck on "working".
  await new Promise((done) => setTimeout(done, 100));
  for (let waited = 0; waited < 600 && conversationBusy; waited++)
    await new Promise((done) => setTimeout(done, 500));
  return lastReply;
};
/* Wave 8: a live conversation belongs to the conversation on screen, and what was said on either
   side goes into it as an ordinary message. public/voice-live.js calls these two. */
globalThis.branchSessionId = () => sessionId;
globalThis.branchAdoptSession = (id) => { if (!sessionId && id) { sessionId = id; $("temporary-toggle").disabled = true; } };
globalThis.branchAddSpokenMessage = (role, text) => { if (text) message(role, text); };

$("chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const typed = $("prompt").value.trim();
  if (!typed) return;
  /* Wave 8: typing while it is talking sends the line straight into the live conversation, which
     answers out loud without you waiting for it to finish what it was saying. */
  if (globalThis.branchLiveState?.() !== "idle" && globalThis.branchSayLive?.(typed)) {
    message("user", typed);
    $("prompt").value = "";
    return;
  }
  if (conversationBusy) return;
  /* Wave 7: "/model" changes the model for this conversation only; nothing is sent to the model. */
  if (await runSlashCommand(typed)) { $("prompt").value = ""; return; }
  /* Batch 19 (wave 6): when "Ask me questions first" is on, the answers are added to the request. */
  const asked = $("ask-first-toggle")?.checked
    ? await (window.branchMisc?.askBeforeStarting(typed) ?? Promise.resolve(typed))
    : typed;
  /* Wave 8 (A1940): one message may be put to a specialist rather than to the assistant itself.
     The choice is per message — the next one goes back to the assistant unless it is chosen again —
     and the reply is signed with the specialist's own name. */
  const answering = chosenSpecialist();
  const prompt = answering ? `Delegate to specialist ${answering.id}: ${asked}` : asked;
  setConversationBusy(true);
  // A send really starts here (public/follow-newest.js tells its first id apart from the person opening one).
  document.dispatchEvent(new CustomEvent("branch-send-started"));
  const startsConversation = !sessionId;
  if (startsConversation) $("conversation").replaceChildren();
  // FQ-surfaces.playback: the sound/video file just attached, handed to this one message's bubble.
  const clips = globalThis.branchPlaybackAttachments?.() ?? [];
  message("user", asked, clips.length ? { clips } : undefined);
  $("prompt").value = "";
  const stopActivity = watchActivity(prompt);
  // Wave 6: the live row you can step into while it works.
  globalThis.branchLiveRun?.watch(sessionId, prompt);
  try {
    const startingTemporary = !sessionId && $("temporary-toggle").checked;
    // Pictures put on the composer travel with this one message and are then cleared (wave 5).
    const pictures = globalThis.branchAttachments?.() ?? [];
    // Wave: the files themselves are kept, so the conversation can hand them back later.
    const files = globalThis.branchAttachedFiles?.() ?? [];
    /* Redesign phase 1: a conversation begun here starts in the mode its chip shows (public/conversation-mode.js). */
    const startMode = sessionId ? null : globalThis.branchConversationMode?.pending() ?? null;
    const run = await api("run", {
      prompt,
      ...(sessionId ? { sessionId } : {}),
      ...(startMode ? { mode: startMode } : {}),
      ...(startingTemporary ? { temporary: true } : {}),
      ...(pictures.length ? { images: pictures } : {}),
      ...(files.length ? { attachments: files } : {}),
    });
    globalThis.branchAttachmentsClear?.();
    if (!sessionId) currentTemporary = startingTemporary;
    sessionId = run.sessionId;
    // FQ-surfaces.playback: the redraw below matches these clips to the message the server saved.
    globalThis.branchPlaybackExpect?.(sessionId, clips, run.userMessageId ?? undefined);
    $("temporary-toggle").disabled = true;
    $("conversation").dataset.sessionId = sessionId;
    /* Wave 8: an artifact in this reply is kept beside the task it came out of, so the task's
       number has to be somewhere the artifact card can find it. */
    if (run.id) globalThis.branchLastRunId = run.id;
    message("assistant", run.output, answering ? { author: answering.name } : undefined);
    /* Wave 7: talk mode reads this out loud once the reply is on the screen. */
    lastReply = run.output;
    $("session-label").textContent = currentTemporary ? run.status + " · temporary, not saved" : run.status + " · conversation saved";
    await loadConversation(run.sessionId, run.status);
    await refresh();
    await loadSessionModel();
    /* The conversation is saved now: Recents (public/shell.js) and the calm window's one-time
       suggestion (public/layout.js) hear it here, not only after New conversation or a reload. */
    document.dispatchEvent(new CustomEvent("branch-run-finished", { detail: {
      sessionId: run.sessionId, status: run.status, temporary: currentTemporary,
      completedRuns: (state.runs ?? []).filter((entry) => entry.status === "completed").length,
    } }));
    // Auto-read-aloud when setting is enabled
    if (typeof speakText !== "undefined") {
      try {
        const settings = await api("voice/settings").catch(() => ({}));
        if (settings.autoReadAloud) {
          const useProvider = settings.useProviderVoice ?? false;
          // A Trunk's conversation is read in that Trunk's own voice; any other in the owner's.
          const talking = await api(`trunks/conversations/${sessionId}`).catch(() => null);
          await speakText(run.output, useProvider, talking?.trunk?.voice ?? "").catch(() => {});
        }
      } catch { /* voice is optional */ }
    }
  } catch (e) {
    message("assistant", e.message);
  } finally {
    document.dispatchEvent(new CustomEvent("branch-send-settled"));
    globalThis.branchPlaybackSettle?.();
    stopActivity();
    globalThis.branchLiveRun?.stop(sessionId);
    globalThis.branchConversationFacts?.refresh();
    setConversationBusy(false);
    if (pendingFollowUps > 0) void awaitFollowUps();
  }
});
/** While a task runs, shows what the assistant is doing right now and how earlier steps ended. */
function watchActivity(prompt) {
  const box = $("activity");
  const marks = { done: "✓", failed: "✗", stopped: "⏱", working: "…" };
  const render = (item) => {
    /* Q51: waiting for you, for a service, or blocked, in words, before what it last did. */
    box.replaceChildren(el("strong", taskWords(item.task) || item.current || "Finishing up"));
    const when = taskWhen(item.task);
    if (when) box.append(el("p", when, "meta task-when"));
    const steps = item.steps.slice(-6);
    if (steps.length) box.append(el("p", steps.map((s) => `${marks[s.status] || ""} ${s.label}`).join("  ·  "), "meta"));
    if (item.followUps) box.append(el("p", `${item.followUps} message(s) waiting to be answered next`, "meta"));
    box.hidden = false;
  };
  const poll = async () => {
    try {
      /* Its own task is running while this polls; one that stops to ask ends the reply, so running tasks suffice. */
      const running = await api("activity");
      const mine = running.find((r) => (sessionId ? r.sessionId === sessionId : r.prompt === prompt));
      if (mine) render(mine); else if (!box.hidden) box.replaceChildren(el("strong", "Finishing up"));
    } catch { /* the reply itself will report problems */ }
  };
  box.replaceChildren(el("strong", "Thinking")); box.hidden = false;
  const timer = setInterval(poll, 1000);
  return () => { clearInterval(timer); box.hidden = true; box.replaceChildren(); };
}
$("new-session").addEventListener("click", async () => {
  if (conversationBusy) return;
  if (currentTemporary && sessionId) {
    try { await api(`sessions/${sessionId}/discard`, {}); toast("Temporary conversation discarded."); }
    catch (e) { toast(e.message); }
  }
  currentTemporary = false;
  $("temporary-toggle").checked = false;
  $("temporary-toggle").disabled = false;
  sessionId = null;
  currentBranch = null;
  currentImported = false;
  $("conversation").dataset.sessionId = "";
  $("conversation").replaceChildren();
  $("thread-name").textContent = "";
  $("session-label").textContent = "New conversation";
  renderConversationContext();
  sessionModel = { preset: null, reasoning: null };
  $("model-controls").hidden = true;
});
$("demo-prompt").addEventListener("click", () => {
  $("prompt").value =
    "Write a greeting to branch-demo.txt, read it, and verify the contents.";
  $("prompt").focus();
});
function form(id, handler) {
  $(id).addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = event.currentTarget.querySelector("button");
    submit.disabled = true;
    try {
      await handler();
      toast("Saved.");
    } catch (e) {
      toast(e.message);
    } finally {
      submit.disabled = false;
    }
  });
}
form("memory-form", () =>
  action("memory.put", {
    text: $("memory-text").value,
    source: $("memory-source").value,
    ...($("memory-entity").value.trim() ? { entity: $("memory-entity").value.trim() } : {}),
    ...($("memory-attribute").value.trim() ? { attribute: $("memory-attribute").value.trim() } : {}),
    ...($("memory-shared").checked ? { scope: "shared" } : {}),
  }),
);
async function renderArchived() {
  try {
    const { archived } = await api("memory/archive");
    list("archived-list", archived, (r) => {
      const node = el("div", undefined, "record");
      node.append(el("p", r.data.text), el("p", `Set aside ${date(r.archivedAt)}`, "meta"),
        button("Bring back", async () => { await api(`memory/archive/${encodeURIComponent(r.id)}/restore`, {}); toast("Back in memory."); await refresh(); await renderArchived(); }));
      return node;
    }, ["Nothing has been set aside.", "Notes you put away stay here in case you want them back."]);
  } catch { /* shown on the next visit */ }
}
$("tidy-preview").addEventListener("click", async () => {
  try {
    const result = await api("memory/hygiene", { olderThanDays: Number($("tidy-days").value) || 180, action: "preview" });
    list("tidy-list", result.stale, (s) => { const node = el("div", undefined, "record"); node.append(el("p", s.text), el("p", `Last touched ${date(s.updatedAt)}`, "meta")); return node; }, ["Nothing that old is saved.", "Notes older than the age you chose would be listed here."]);
  } catch (e) { toast(e.message); }
});
$("tidy-archive").addEventListener("click", async () => {
  try {
    const result = await api("memory/hygiene", { olderThanDays: Number($("tidy-days").value) || 180, action: "archive" });
    toast(result.archived.length ? `${result.archived.length} set aside.` : "Nothing that old is in memory.");
    $("tidy-list").replaceChildren(); await refresh(); await renderArchived();
  } catch (e) { toast(e.message); }
});
form("memory-capacity-form", async () => {
  const submitted = $("memory-capacity").value;
  await api("memory/capacity", { maxFacts: Number(submitted) });
  if (memoryCapacityDraft === submitted) memoryCapacityDraft = null;
  await refresh();
});
$("memory-capacity").addEventListener("input", () => { memoryCapacityDraft = $("memory-capacity").value; });
$("memory-transfer").append(button("Export memory JSON", async () => {
  if (await exportArchive(await api("memory/export"), "exportMemory", "branch-memory.json")) toast("Memory exported.");
}), button("Import memory JSON", () => $("memory-import").click()));
$("memory-import").addEventListener("change", async () => {
  const input = $("memory-import"), file = input.files[0]; input.value = "";
  if (!file || input.disabled) return;
  input.disabled = true;
  try {
    if (file.size > 16 * 1024 * 1024) throw new Error("Memory archives must be at most 16 MiB.");
    let archive;
    try { archive = JSON.parse(await file.text()); } catch { throw new Error("Choose a valid memory JSON file."); }
    const result = await api("memory/import", archive);
    $("memory-import-result").textContent = `${result.imported} facts imported; ${result.unchanged} unchanged.`;
    await refresh();
  } catch (error) { $("memory-import-result").textContent = error.message; }
  finally { input.disabled = false; }
});
$("history-search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.currentTarget.querySelector("button");
  submit.disabled = true;
  $("history-message").hidden = true;
  $("history-results").replaceChildren(el("p", "Searching conversations…"));
  historyReadRevision++;
  try {
    const value = await api("action", { tool: "history.search", args: {
      query: $("history-query").value, match: $("history-match").value,
    } });
    list("history-results", value.results, (match) => {
      const card = recordCard(match.role === "user" ? "You said" : "Branch Agent replied");
      card.append(el("small", "Conversation started " + date(match.sessionCreatedAt)),
        el("p", match.excerpt), button("Read message", () => readHistoricalMessage(match)));
      return card;
    }, ["Nothing matched.", "Try fewer words, or set the search to match any word instead of all of them."]);
  } catch (error) {
    $("history-results").replaceChildren(el("p", "Conversation search failed. Please try again."));
    toast(error.message);
  }
  finally { submit.disabled = false; }
});
async function readHistoricalMessage(match, offset = 0) {
  const revision = ++historyReadRevision;
  const value = await api("action", { tool: "history.read", args: {
    sessionId: match.sessionId, messageId: match.messageId, offset,
  } });
  if (revision !== historyReadRevision) return;
  const detail = $("history-message");
  if (!offset) detail.replaceChildren(
    el("h3", value.role === "user" ? "Your message" : "Branch Agent’s reply"),
    el("small", "Conversation started " + date(value.sessionCreatedAt)), el("pre", ""),
    el("p", "Branching copies the conversation through this message. Workspace files and saved memory remain shared."),
    conversationButton("Branch from here", () => branchConversation(value.sessionId, value.messageId)),
    conversationButton("Open conversation", () => openConversation(value.sessionId)));
  detail.querySelector("pre").append(document.createTextNode(value.content));
  detail.querySelector(".history-read-more")?.remove();
  if (value.nextOffset !== null) {
    const more = button("Read more", () => readHistoricalMessage(match, value.nextOffset));
    more.classList.add("history-read-more"); detail.append(more);
  }
  detail.hidden = false;
}
form("specialist-form", () =>
  action("specialists.propose", JSON.parse($("specialist-json").value)),
);
form("procedure-form", () =>
  action("procedures.propose", JSON.parse($("procedure-json").value)),
);
form("schedule-form", () =>
  action("schedules.create", {
    prompt: $("schedule-prompt").value,
    dueAt: new Date($("schedule-time").value).toISOString(),
    kind: $("schedule-kind").value,
    ...($("schedule-daily").value
      ? { dailyAt: $("schedule-daily").value, timezone: $("schedule-timezone").value || Intl.DateTimeFormat().resolvedOptions().timeZone }
      : {}),
    ...($("schedule-deliver").value
      ? { deliverTo: JSON.parse($("schedule-deliver").value) }
      : {}),
    ...($("schedule-webhook").checked ? { webhook: true } : {}),
    ...(Number($("schedule-repeat").value) && !$("schedule-daily").value
      ? { intervalMs: Number($("schedule-repeat").value) }
      : {}),
  }),
);
$("specialist-json").value = JSON.stringify(
  {
    name: "Workspace helper",
    instructions: "Write and verify the requested greeting.",
    permissions: ["files.read", "files.write"],
    evaluation: {
      prompt:
        "Write Hello from Branch. followed by a newline to branch-demo.txt and verify it.",
      checks: [{ path: "branch-demo.txt", expected: "Hello from Branch.\n" }],
    },
  },
  null,
  2,
);
$("procedure-json").value = JSON.stringify(
  {
    name: "Write a checked greeting",
    preconditions: [],
    steps: [
      {
        tool: "files.write",
        args: { path: "greeting.txt", content: "Hello" },
        expected: { path: "greeting.txt", bytes: 5 },
      },
      {
        tool: "files.verify",
        args: { path: "greeting.txt", expected: "Hello" },
        expected: { path: "greeting.txt", verified: true },
      },
    ],
  },
  null,
  2,
);
initAppearance((value) => api("preferences", value));
$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    savedAppearance = JSON.stringify(await api("preferences", currentAppearance()));
    toast("Appearance saved.");
  } catch (error) {
    toast(error.message);
  }
});
$("appearance-shortcut").addEventListener("click", () => {
  displayView("settings");
  if ($("workspace").hidden) toast("Connect to change settings.");
});
$("schedule-timezone").value = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (token || desktop) refresh().catch((e) => toast(e.message));
function modelConnectionFields() {
  const demonstration = $("model-provider").value === "demo";
  $("model-connection-fields").hidden = demonstration;
  $("model-connection-fields").querySelectorAll("input").forEach((input) => {
    input.disabled = demonstration;
  });
}
function showModelSettings(value) {
  $("model-settings-form").hidden = false;
  $("model-provider").value = value.provider;
  $("model-endpoint").value = value.endpoint;
  $("model-name").value = value.model;
  $("model-key").value = "";
  $("model-key").placeholder = value.hasKey ? "Saved key — leave blank to keep" : "Enter API key";
  $("model-key-note").textContent = value.canStoreKey
    ? "Stored with this device’s key protection. Saved keys are never displayed here."
    : "Device key protection is unavailable. Configure the provider in the launch environment.";
  $("model-settings-fields").disabled = Boolean(value.environmentOverride);
  $("model-settings-note").textContent = (value.issue ? value.issue + " " : "") + (value.environmentOverride
    ? "The launch environment controls the active model. Remove BRANCH_PROVIDER there to use these settings."
    : "Save your connection, then quit and reopen Branch Agent to use it. Provider usage may incur charges.");
  if (value.issue) toast(value.issue);
  modelConnectionFields();
}
$("model-provider").addEventListener("change", modelConnectionFields);
if (window.branchDesktop) {
  window.branchDesktop.modelSettings().then(showModelSettings).catch((e) => toast(e.message));
  form("model-settings-form", async () => {
    const input = {
      provider: $("model-provider").value, endpoint: $("model-endpoint").value,
      model: $("model-name").value, apiKey: $("model-key").value,
    };
    $("model-key").value = "";
    let saved;
    try {
      saved = await window.branchDesktop.saveModelSettings(input);
    } finally {
      input.apiKey = "";
    }
    showModelSettings(saved);
    $("model-settings-note").textContent = "Connection saved. Quit from the tray and reopen Branch Agent to apply it.";
  });
}
// Voice input and output handlers
if (typeof initVoiceRecording !== "undefined") {
  // Show the button when this browser can record; permission is asked for on the first press.
  $("voice-record").hidden = !navigator.mediaDevices?.getUserMedia;
  $("voice-record").addEventListener("mousedown", startVoiceRecording);
  $("voice-record").addEventListener("mouseup", stopVoiceRecording);
  $("voice-record").addEventListener("touchstart", startVoiceRecording);
  $("voice-record").addEventListener("touchend", stopVoiceRecording);
  $("voice-record").addEventListener("mouseleave", stopVoiceRecording);
  $("voice-record").addEventListener("touchcancel", stopVoiceRecording);
}
if ($("voice-settings-save")) {
  $("voice-settings-save").addEventListener("click", async () => {
    try {
      await saveVoiceSettings();
      await loadVoiceSettings();
      toast("Voice settings saved");
    } catch (e) {
      toast("Failed to save voice settings: " + (e instanceof Error ? e.message : String(e)));
    }
  });
}
if (token && typeof loadVoiceSettings !== "undefined") {
  loadVoiceSettings().catch((e) => console.error("Failed to load voice settings:", e));
}
let automations = null;
import("./automations.js").then((module) => {
  automations = module;
  if (state) renderAutomations();
}).catch(() => {});
function renderAutomations() {
  const container = $("automations-container");
  if (!container || !automations || !state) return;
  container.replaceChildren(automations.showAutomations(state, { el, api, toast, refresh }));
}
/* Wave 6: workflows, the waiting line, days off, shared copies and the people here. */
let collab = null;
import("./collab.js").then((module) => {
  collab = module;
  if (state) renderCollab();
}).catch(() => {});
function renderCollab() {
  const container = $("collab-container");
  if (!collab || !state) return;
  collab.showProfileBadge(state, { el, api, toast, refresh }); // household-followups
  if (!container) return;
  container.replaceChildren(collab.showCollab(state, { el, api, toast, refresh }));
}
setInterval(() => {
  if (token || desktop) refresh().catch(() => {});
}, 3000);

// Initialize provider selection UI
import("./providers.js").then((mod) => {
  // Call initProvidersUI when settings view is shown
  const originalShowModelSettings = showModelSettings;
  globalThis.showModelSettings = function(value) {
    originalShowModelSettings(value);
    mod.initProvidersUI().catch((e) => toast(`Provider UI error: ${e.message}`));
  };
}).catch((e) => console.error("Failed to load providers UI:", e));

/* Used by public/shell.js (the rail and the command palette). */
export { api, displayView, openConversation, titles };
