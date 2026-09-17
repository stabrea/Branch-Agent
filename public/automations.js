// Automations panel: inbound triggers ("when something happens elsewhere") and
// outbound webhooks ("let another app know"). app.js imports this and passes the
// current state plus its own small helpers, so nothing here depends on globals.

/**
 * Builds the panel. `helpers` supplies el, api, toast and refresh from app.js.
 */
export function showAutomations(state, helpers) {
  const panel = helpers.el("div", undefined, "automations-panel");
  panel.appendChild(triggersSection(state.triggers ?? [], helpers));
  panel.appendChild(webhooksSection(state.webhooks ?? [], helpers));
  return panel;
}

/** Runs a click handler, shows whatever went wrong instead of failing silently. */
function onClick(helpers, node, handler) {
  node.type = "button";
  node.addEventListener("click", async () => {
    node.disabled = true;
    try {
      await handler();
    } catch (error) {
      helpers.toast(error.message);
    } finally {
      node.disabled = false;
    }
  });
  return node;
}

function smallButton(helpers, label, handler) {
  return onClick(helpers, helpers.el("button", label, "automations-btn-small"), handler);
}

/* The screen is drawn again on every refresh, and a list someone opened used to vanish with it.
   What each open list last showed is kept here, so it is drawn again open. */
const shownLogs = new Map();

/** A place under one item where its recent activity is written, instead of a pop-up. */
function logArea(helpers, key) {
  const area = helpers.el("pre", undefined, "automations-log");
  area.dataset.log = key;
  area.hidden = !shownLogs.has(key);
  if (shownLogs.has(key)) area.textContent = shownLogs.get(key);
  return area;
}
function writeLog(area, lines, empty) {
  const text = lines.length ? lines.join("\n") : empty;
  shownLogs.set(area.dataset.log, text);
  /* The list may have been drawn again while the history was fetched; write into the one on screen. */
  const current = document.querySelector(`.automations-log[data-log="${area.dataset.log}"]`) ?? area;
  current.textContent = text;
  current.hidden = false;
}

function section(helpers, title, description) {
  const node = helpers.el("div", undefined, "automations-section");
  node.appendChild(helpers.el("h3", title));
  node.appendChild(helpers.el("p", description, "automations-desc"));
  return node;
}

function triggersSection(triggers, helpers) {
  const { el, api, toast, refresh } = helpers;
  const wrap = section(
    helpers,
    "When something happens elsewhere",
    "Let another app start a task here. Each one gets its own web address and a secret only that app should know.",
  );
  if (!triggers.length) wrap.appendChild(el("p", "Nothing set up yet.", "automations-empty"));
  else {
    const list = el("div", undefined, "automations-list");
    for (const trigger of triggers) list.appendChild(triggerItem(trigger, helpers));
    wrap.appendChild(list);
  }
  wrap.appendChild(onClick(helpers, el("button", "Add one", "automations-btn"), async () => {
    const name = window.prompt("What should this be called?");
    if (!name) return;
    const text = window.prompt("What should the assistant do? Use {{payload}} for everything the app sends, or {{field.name}} for one part of it.");
    if (!text) return;
    await api("triggers", { name, prompt: text });
    toast("Added. Copy its web address and secret into the other app.");
    await refresh();
  }));
  return wrap;
}

function triggerItem(trigger, helpers) {
  const { el, api, toast, refresh } = helpers;
  const item = el("div", undefined, "automations-item");
  const header = el("div", undefined, "automations-item-header");
  header.appendChild(el("span", trigger.name + (trigger.enabled ? "" : " (turned off)"), trigger.enabled ? "automations-name" : "automations-name automations-disabled"));
  item.appendChild(header);
  item.appendChild(el("div", `${window.location.origin}/api/triggers/${trigger.id}/fire`, "automations-url"));

  const log = logArea(helpers, `trigger:${trigger.id}`);
  const controls = el("div", undefined, "automations-controls");
  controls.appendChild(smallButton(helpers, "Copy web address", async () => {
    await navigator.clipboard.writeText(`${window.location.origin}/api/triggers/${trigger.id}/fire`);
    toast("Web address copied.");
  }));
  controls.appendChild(smallButton(helpers, "Copy secret", async () => {
    await navigator.clipboard.writeText(trigger.secret);
    toast("Secret copied. Paste it into the other app; do not share it anywhere else.");
  }));
  controls.appendChild(smallButton(helpers, "Make a new secret", async () => {
    await api(`triggers/${trigger.id}/rotate-secret`, {});
    toast("New secret made. The old one no longer works.");
    await refresh();
  }));
  controls.appendChild(smallButton(helpers, trigger.enabled ? "Turn off" : "Turn on", async () => {
    await api(`triggers/${trigger.id}/enabled`, { enabled: !trigger.enabled });
    await refresh();
  }));
  controls.appendChild(smallButton(helpers, "Recent activity", async () => {
    const { log: entries } = await api(`triggers/${trigger.id}/log`);
    writeLog(log, entries.map((e) => `${e.createdAt} — ${e.status}${e.runId ? ` (task ${e.runId})` : ""}`), "Nothing has come in yet.");
  }));
  controls.appendChild(smallButton(helpers, "Remove", async () => {
    if (!window.confirm(`Remove "${trigger.name}"? The other app will stop being able to start tasks.`)) return;
    await api(`triggers/${trigger.id}/remove`, {});
    toast("Removed.");
    await refresh();
  }));
  item.appendChild(controls);
  item.appendChild(log);
  return item;
}

function webhooksSection(webhooks, helpers) {
  const { el, api, toast, refresh } = helpers;
  const wrap = section(
    helpers,
    "Let another app know",
    "Send a message to another app when something happens here, such as a task finishing or a question waiting for you.",
  );
  if (!webhooks.length) wrap.appendChild(el("p", "Nothing set up yet.", "automations-empty"));
  else {
    const list = el("div", undefined, "automations-list");
    for (const webhook of webhooks) list.appendChild(webhookItem(webhook, helpers));
    wrap.appendChild(list);
  }
  wrap.appendChild(onClick(helpers, el("button", "Add one", "automations-btn"), async () => {
    const name = window.prompt("What should this be called?");
    if (!name) return;
    const url = window.prompt("Which web address should we send to?");
    if (!url) return;
    const secret = window.prompt("Shared secret, so the other app can check the message really came from here (optional):");
    await api("webhooks", { name, url, ...(secret ? { secret } : {}), events: ["run.completed", "run.failed"] });
    toast("Added. It will be told when a task finishes.");
    await refresh();
  }));
  return wrap;
}

function webhookItem(webhook, helpers) {
  const { el, api, toast, refresh } = helpers;
  const item = el("div", undefined, "automations-item");
  const header = el("div", undefined, "automations-item-header");
  header.appendChild(el("span", webhook.name + (webhook.enabled ? "" : " (turned off)"), webhook.enabled ? "automations-name" : "automations-name automations-disabled"));
  item.appendChild(header);
  item.appendChild(el("div", webhook.url, "automations-url"));
  item.appendChild(el("div", "Tells it about: " + (webhook.events?.length ? webhook.events.join(", ") : "nothing yet"), "automations-events"));
  if (webhook.disabledReason) item.appendChild(el("div", webhook.disabledReason, "automations-events"));

  const log = logArea(helpers, `webhook:${webhook.id}`);
  const controls = el("div", undefined, "automations-controls");
  controls.appendChild(smallButton(helpers, "Send a test", async () => {
    const result = await api(`webhooks/${webhook.id}/test`, {});
    toast(result.ok ? `The other app answered: ${result.message}` : `It did not work: ${result.message}`);
  }));
  controls.appendChild(smallButton(helpers, "Delivery history", async () => {
    const { log: entries } = await api(`webhooks/${webhook.id}/log`);
    writeLog(log, entries.map((e) => `${e.createdAt} — ${e.eventType}: ${e.status} (try ${e.attempt})`), "Nothing has been sent yet.");
  }));
  if (!webhook.enabled)
    controls.appendChild(smallButton(helpers, "Turn back on", async () => {
      await api(`webhooks/${webhook.id}/enable`, {});
      toast("Turned back on.");
      await refresh();
    }));
  controls.appendChild(smallButton(helpers, "Remove", async () => {
    if (!window.confirm(`Remove "${webhook.name}"? That app will stop being told about anything.`)) return;
    await api(`webhooks/${webhook.id}/remove`, {});
    toast("Removed.");
    await refresh();
  }));
  item.appendChild(controls);
  item.appendChild(log);
  return item;
}
