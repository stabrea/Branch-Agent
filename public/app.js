const $ = (id) => document.getElementById(id);
const desktop = new URLSearchParams(location.search).get("desktop") === "1";
if (desktop) document.querySelector(".brand").href = "/?desktop=1";
let savedAppearance;
let historyReadRevision = 0;
let conversationBusy = false;
let currentBranch = null;
let currentImported = false;
let currentTemporary = false;
let savedSearchRevision = 0;
let savedNextOffset = null;
let savedQuery = "";
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
  memory: "Memory",
  specialists: "Specialists",
  procedures: "Procedures",
  schedules: "Schedules",
  settings: "Settings",
  skills: "Skills",
};
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  setTimeout(() => {
    $("toast").hidden = true;
  }, 6000);
}
async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + token,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
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
  document.querySelectorAll(".view").forEach((node) => {
    node.hidden = node.id !== view;
  });
  document
    .querySelectorAll(".nav")
    .forEach((node) =>
      node.classList.toggle("active", node.dataset.view === view),
    );
  $("page-title").textContent = titles[view];
}
document
  .querySelectorAll(".nav")
  .forEach((node) =>
    node.addEventListener("click", () => displayView(node.dataset.view)),
  );
function list(id, items, render, empty) {
  const target = $(id);
  target.replaceChildren(...items.map(render));
  if (!items.length) target.append(el("div", empty, "empty"));
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
      node.append(el("p", run.output || "Working…"));
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
        button("Inspect trace", () => showRun(run.id)),
      );
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
  if (focused?.isConnected && document.activeElement !== focused) {
    focused.focus({ preventScroll: true });
    if (selection) focused.setSelectionRange(...selection);
  }
}
function memoryCard(record) {
  const node = recordCard(record.data.text);
  node.dataset.memoryId = record.id;
  const edit = button("Edit", () => { memoryEditors.set(record.id, { ...record.data, revision: record.revision }); renderMemory(); });
  edit.disabled = memoryEditors.has(record.id);
  node.append(el("p", record.data.source), el("p", date(record.createdAt), "meta"), edit,
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
  list(
    "specialists-list",
    state.specialists,
    specialistCard,
    "Propose a focused assistant and test its work before activation.",
  );
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
  state = await api("state");
  $("login").hidden = true;
  $("workspace").hidden = false;
  $("lock").hidden = desktop;
  $("connection").textContent = "Connected";
  const active = state.activeModel ?? { provider: state.provider, presetName: state.provider, model: "" };
  const demo = active.provider === "offline-demo-fixture";
  $("provider").textContent = demo ? "Offline demonstration" : `${active.presetName} · ${active.model}`;
  if (savedAppearance !== state.preferences.appearance) {
    savedAppearance = state.preferences.appearance;
    applyAppearance(savedAppearance);
  }
  $("context-provider").textContent = demo ? "Not connected" : active.presetName;
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
  renderIdentity();
  renderSkills();
  renderModels();
  renderChatGPT();
  renderUpdates();
  renderFirstRun();
  renderProjects();
  void renderSecrets();
  void renderChannels();
  renderAttention();
}
const notifiedAttention = new Set();
function renderAttention() {
  const waiting = state.attention || [];
  const banner = $("attention");
  banner.hidden = !waiting.length;
  banner.replaceChildren(...waiting.map((item) => {
    const row = el("div", undefined, "attention-row");
    row.append(el("strong", "Your assistant needs you"), el("span", item.question),
      button("Open conversation", () => { displayView("chat"); openConversation(item.sessionId); }));
    return row;
  }));
  for (const item of waiting) {
    if (notifiedAttention.has(item.runId)) continue;
    notifiedAttention.add(item.runId);
    if (typeof Notification === "undefined") continue;
    const show = () => {
      const note = new Notification("Your assistant needs you", { body: item.question.slice(0, 200), tag: item.runId });
      note.onclick = () => { window.focus(); displayView("chat"); openConversation(item.sessionId); };
    };
    if (Notification.permission === "granted") show();
    else if (Notification.permission !== "denied") Notification.requestPermission().then((p) => { if (p === "granted") show(); }).catch(() => undefined);
  }
}
async function renderChannels() {
  let summary;
  try { summary = await api("channels"); } catch { return; }
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
      el("p", `${channel.activation === "always" ? "Answers every group message" : "Answers when mentioned or replied to"} · ${channel.pairing ? "new people pair with a code" : "only listed people"}`, "meta"));
    return node;
  }, "No channel connected in this launch.");
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
  }, "Nothing is waiting. Everything sent through a channel has gone out.");
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
    return node;
  }, "No secrets in this project yet.");
}
$("secret-project").addEventListener("change", () => { void renderSecrets(); });
form("secrets-form", async () => {
  const value = $("secret-value").value;
  $("secret-value").value = "";
  await api("secrets", { project: $("secret-project").value, name: $("secret-name").value.trim(), value });
  $("secret-name").value = "";
  await renderSecrets();
});
let firstRunDoor = null, firstRunTimer = null;
function renderFirstRun() {
  const show = state.onboarding && !state.onboarding.done;
  $("first-run").hidden = !show;
  if (!show) { clearTimeout(firstRunTimer); return; }
  const active = state.activeModel;
  if (active && active.provider !== "offline-demo-fixture" && firstRunDoor !== "demo")
    $("first-run-status").textContent = `Ready: ${active.presetName} will answer. Test it, then start chatting.`;
}
function chooseDoor(door) {
  firstRunDoor = door;
  for (const id of ["door-chatgpt", "door-key", "door-demo"]) $(id).classList.toggle("selected", id === "door-" + door);
  $("first-run-done").hidden = true;
}
$("door-chatgpt").addEventListener("click", async () => {
  chooseDoor("chatgpt");
  const prompt = await startChatGPTLogin();
  if (!prompt) return;
  $("first-run-status").textContent = `Enter ${prompt.userCode} on the sign-in page that just opened (${prompt.verificationUrl}). This page updates by itself when you finish.`;
  const poll = async () => {
    const status = await api("chatgpt/status").catch(() => null);
    if (status?.signedIn) { await refresh(); $("first-run-status").textContent = "Signed in. Test the connection, then start chatting."; return; }
    if ($("first-run").hidden) return;
    firstRunTimer = setTimeout(poll, 3000);
  };
  firstRunTimer = setTimeout(poll, 3000);
});
$("door-key").addEventListener("click", () => {
  chooseDoor("key");
  $("first-run-status").textContent = window.branchDesktop
    ? "Fill in Settings → Model connection, then come back here and test it."
    : "Set BRANCH_PROVIDER, BRANCH_ENDPOINT, BRANCH_MODEL and BRANCH_API_KEY where you start Branch, restart it, then test here.";
  if (window.branchDesktop) { displayView("settings"); $("model-provider").focus(); }
});
$("door-demo").addEventListener("click", () => {
  chooseDoor("demo");
  $("first-run-status").textContent = "You are on the offline demonstration. It can only write, read and check one greeting file, but everything else in the app works.";
  $("first-run-done").hidden = false;
});
$("first-run-test").addEventListener("click", async () => {
  $("first-run-test").disabled = true;
  $("first-run-status").textContent = "Testing…";
  try {
    const result = await api("models/test", {});
    $("first-run-status").textContent = `${result.presetName} answered in ${(result.ms / 1000).toFixed(1)} s${result.reply ? `: “${result.reply}”` : "."}`;
    $("first-run-done").hidden = false;
  } catch (e) {
    $("first-run-status").textContent = e.message;
  } finally { $("first-run-test").disabled = false; }
});
$("first-run-done").addEventListener("click", async () => {
  try { await api("onboarding", { done: true }); await refresh(); toast("You're set. Say hello."); $("prompt").focus(); }
  catch (e) { toast(e.message); }
});
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
function showUpdateStatus(status) {
  $("updates-status").textContent = status.message;
  const working = ["checking", "downloading", "verifying", "unpacking", "ready"].includes(status.phase);
  $("updates-progress").hidden = status.progress === null;
  $("updates-bar").style.width = `${Math.round((status.progress ?? 0) * 100)}%`;
  $("updates-check").disabled = working || status.phase === "unsupported";
  $("updates-install").hidden = status.phase !== "available" && !working;
  $("updates-install").disabled = working;
  $("updates-install").textContent = working ? "Updating…" : "Update and restart";
  clearTimeout(updatesTimer);
  if (working) updatesTimer = setTimeout(() => window.branchDesktop.updateStatus().then(showUpdateStatus), 700);
}
async function renderUpdates() {
  $("updates-card").hidden = !window.branchDesktop;
  $("updates-version").textContent = `Branch Agent ${state.version}`;
  if (!window.branchDesktop) return;
  try { showUpdateStatus(await window.branchDesktop.updateStatus()); } catch (e) { $("updates-status").textContent = e.message; }
}
$("updates-check").addEventListener("click", async () => {
  try { showUpdateStatus(await window.branchDesktop.checkForUpdates()); } catch (e) { toast(e.message); }
});
$("updates-install").addEventListener("click", async () => {
  try { showUpdateStatus(await window.branchDesktop.installUpdate()); } catch (e) { toast(e.message); await renderUpdates(); }
});
function modelLine(model) {
  if (!model) return "Model: not recorded";
  const name = model.presetName || model.presetId;
  const fallback = model.fellBackFrom ? ` (after ${model.fellBackFrom} was unavailable)` : "";
  return `Model: ${name} · ${model.model}${fallback}`;
}
function presetOptions(select, presets, firstLabel, value) {
  const focused = document.activeElement === select;
  select.replaceChildren(
    ...(firstLabel ? [el("option", firstLabel)] : []),
    ...presets.map((preset) => {
      const option = el("option", `${preset.name} · ${preset.model}`);
      option.value = preset.id;
      if (preset.coolingDownUntil) option.textContent += " (resting)";
      return option;
    }),
  );
  if (firstLabel) select.options[0].value = "";
  if (!focused) select.value = value ?? "";
}
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
  $("models-note").textContent = models.presets.length > 1
    ? `${models.presets.length} models available.`
    : "One model is configured. Add more with BRANCH_MODEL_PRESETS in the launch environment, or in the desktop connection settings.";
  presetOptions($("session-model"), models.presets, "Workspace default", sessionModel.preset);
}
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
  list("skills-list", state.skills || [], value => {
    const node = recordCard(value.name, value.activeVersion === null ? "disabled" : "enabled");
    node.dataset.skillId = value.id;
    node.append(el("p", value.description), el("p", `Latest v${value.headVersion} · ${value.activeVersion === null ? "No active version" : `Active v${value.activeVersion}: ${value.activeName}`}`, "meta"));
    const open = button("Open skill", () => skillOperation(async () => {
      selectSkill(await api("skills/" + value.id));
    }));
    open.disabled = skillBusy; node.append(open); return node;
  }, "No skills installed. Create a SKILL.md document or import a local file.");
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
}
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
  void skillOperation(() => mutateSkill(operation, operation === "activate" ? { version: Number($("skill-version").value) } : {}));
};
selectSkill(null);
function renderIdentity() {
  $("brand-name").textContent = state.identity?.name || "Branch Agent";
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
function message(role, content, source) {
  const node = el("div", undefined, "message " + (source?.toolCalls?.length ? "assistant-step" : role));
  node.append(
    el("small", role === "user" ? "You" : "Branch Agent"),
    document.createTextNode(content),
  );
  if (source?.messageId && !source.toolCalls?.length) {
    const controls = el("div", undefined, "message-controls");
    controls.append(conversationButton("Branch from here", () => branchConversation(sessionId, source.messageId)));
    node.append(controls);
  }
  $("conversation").append(node);
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
function setConversationBusy(busy) {
  conversationBusy = busy;
  $("send").disabled = busy;
  $("new-session").disabled = busy;
  $("conversation-import").disabled = busy;
  document.querySelectorAll(".conversation-switch").forEach(node => { node.disabled = busy; });
}
function selectConversation(id, branch = null, imported = false) {
  sessionId = id;
  currentBranch = branch;
  currentImported = imported;
  $("conversation").dataset.sessionId = id || "";
  $("session-label").textContent = branch ? "Branched conversation" : imported ? "Imported conversation" : "Saved conversation";
  $("saved-conversations").open = false;
  displayView("chat");
  renderConversationContext();
}
function renderConversationContext() {
  const context = $("session-context");
  context.replaceChildren();
  context.hidden = !sessionId;
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
          toast(`Removed ${result.removed} from memory.`);
          await refresh(); renderConversationContext();
        } catch (e) { toast(e.message); }
      }));
  }
  context.append(panel);
}
function renderConversation(value, status) {
  selectConversation(value.sessionId, value.branch, value.imported);
  $("conversation").replaceChildren();
  for (const source of value.messages) {
    if (["user", "assistant"].includes(source.role)) message(source.role, source.content, source);
  }
  if (status) $("session-label").textContent = status + (value.branch ? " · branched conversation" : value.imported ? " · imported conversation" : " · conversation saved");
}
async function loadConversation(id, status) {
  try {
    renderConversation(await api("sessions/" + id), status);
    await loadSessionModel();
  } catch (error) {
    renderConversationContext();
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
$("saved-conversations").addEventListener("toggle", () => {
  if ($("saved-conversations").open) void searchSavedConversations();
});
$("saved-search-form").addEventListener("submit", event => {
  event.preventDefault(); void searchSavedConversations();
});
$("saved-more").addEventListener("click", () => {
  if (savedNextOffset !== null) void searchSavedConversations(savedNextOffset);
});
$("import-conversation").addEventListener("click", () => {
  if (!conversationBusy) $("conversation-import").click();
});
$("conversation-import").addEventListener("change", async () => {
  const file = $("conversation-import").files[0]; $("conversation-import").value = "";
  if (!file || conversationBusy) return;
  setConversationBusy(true);
  try { await importConversation(file); } catch (error) { toast(error.message); }
  finally { setConversationBusy(false); }
});
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  token = $("token").value.trim();
  try {
    await refresh();
    sessionStorage.setItem("branch-token", token);
    $("token").value = "";
  } catch (e) {
    toast(e.message);
  }
});
$("lock").addEventListener("click", () => {
  token = "";
  sessionStorage.removeItem("branch-token");
  $("workspace").hidden = true;
  $("login").hidden = false;
  $("lock").hidden = true;
  $("connection").textContent = "Locked";
});
$("chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = $("prompt").value.trim();
  if (!prompt || conversationBusy) return;
  setConversationBusy(true);
  if (!sessionId) $("conversation").replaceChildren();
  message("user", prompt);
  $("prompt").value = "";
  try {
    const startingTemporary = !sessionId && $("temporary-toggle").checked;
    const run = await api("run", {
      prompt,
      ...(sessionId ? { sessionId } : {}),
      ...(startingTemporary ? { temporary: true } : {}),
    });
    if (!sessionId) currentTemporary = startingTemporary;
    sessionId = run.sessionId;
    $("temporary-toggle").disabled = true;
    $("conversation").dataset.sessionId = sessionId;
    message("assistant", run.output);
    $("session-label").textContent = currentTemporary ? run.status + " · temporary, not saved" : run.status + " · conversation saved";
    await loadConversation(run.sessionId, run.status);
    await refresh();
    await loadSessionModel();
  } catch (e) {
    message("assistant", e.message);
  } finally {
    setConversationBusy(false);
  }
});
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
  }),
);
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
    }, "No matching conversations. Try fewer keywords or match any keyword.");
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
function applyAppearance(value) {
  const theme = value === "daylight" ? "daylight" : "forest";
  document.documentElement.dataset.theme = theme;
  $("appearance").value = theme;
}
applyAppearance("forest");
form("settings-form", async () => {
  const value = await api("preferences", { appearance: $("appearance").value });
  savedAppearance = value.appearance;
  applyAppearance(savedAppearance);
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
setInterval(() => {
  if (token || desktop) refresh().catch(() => {});
}, 3000);
