// Sharing, labels and notes, saved workflows, the waiting line for tasks, days off and quiet
// hours, and the people who share this computer. app.js imports this and hands over the current
// state plus its own small helpers, so nothing here depends on globals.

/** Builds the panel shown under Schedules. `helpers` supplies el, api, toast and refresh. */
export function showCollab(state, helpers) {
  const collab = state.collab ?? {};
  const panel = helpers.el("div", undefined, "collab-panel");
  panel.appendChild(labelsSection(collab.labels ?? [], helpers));
  panel.appendChild(workflowsSection(collab.workflows ?? [], helpers));
  panel.appendChild(queueSection(collab.queue ?? { waiting: [], settings: { atOnce: 3 } }, helpers));
  panel.appendChild(daysOffSection(collab.calendar ?? { settings: {}, countries: [] }, helpers));
  panel.appendChild(sharesSection(collab.shares ?? [], helpers));
  panel.appendChild(peopleSection(collab.profile ?? { all: [], active: null, isOwner: true }, helpers));
  return panel;
}

/** Runs a click handler and shows whatever went wrong instead of failing silently. */
function onClick(helpers, node, handler) {
  node.type = "button";
  node.addEventListener("click", async () => {
    node.disabled = true;
    try { await handler(); } catch (error) { helpers.toast(error.message); } finally { node.disabled = false; }
  });
  return node;
}
function smallButton(helpers, label, handler) {
  return onClick(helpers, helpers.el("button", label, "collab-btn-small"), handler);
}
function section(helpers, title, description) {
  const node = helpers.el("div", undefined, "collab-section");
  node.appendChild(helpers.el("h3", title));
  node.appendChild(helpers.el("p", description, "collab-desc"));
  return node;
}
function empty(helpers, wrap, text) {
  wrap.appendChild(helpers.el("p", text, "collab-empty"));
  return wrap;
}

const statusWords = {
  idle: "Not started", running: "Working", paused: "Stopped for now",
  waiting_approval: "Waiting for you", waiting_time: "Waiting for its time",
  completed: "Finished", failed: "Stopped after a problem", interrupted: "Stopped when the app closed",
};

/** Labels in use, and a way to see which conversations carry one. */
function labelsSection(labels, helpers) {
  const { el, api, toast } = helpers;
  const wrap = section(helpers, "Labels",
    "Short words you stick on conversations, saved procedures and documents so you can find them again. Type them however you like; they are kept in lower case.");
  const found = el("div", undefined, "collab-found");
  if (!labels.length) empty(helpers, wrap, "No labels yet.");
  const row = el("div", undefined, "collab-row");
  for (const item of labels)
    row.appendChild(smallButton(helpers, `${item.label} (${item.count})`, async () => {
      const result = await api("/api/sessions/search", { query: "", labels: [item.label] });
      found.replaceChildren(el("p", result.sessions.length
        ? result.sessions.map((session) => session.preview.slice(0, 80) || "(no words)").join("\n")
        : "Nothing carries that label any more.", "collab-meta"));
    }));
  wrap.appendChild(row);
  wrap.appendChild(found);
  const target = el("select");
  for (const [value, label] of [["conversation", "a conversation"], ["procedure", "a saved procedure"], ["document", "a document"]])
    target.appendChild(new Option(label, value));
  const id = el("input"); id.placeholder = "Its number"; id.maxLength = 200; id.setAttribute("aria-label", "The number of the thing to label");
  const label = el("input"); label.placeholder = "Label"; label.maxLength = 40; label.setAttribute("aria-label", "The label to add");
  const adding = el("div", undefined, "collab-row");
  adding.append(el("span", "Add a label to"), target, id, label,
    smallButton(helpers, "Add", async () => {
      await api("/api/labels", { target: target.value, targetId: id.value.trim(), label: label.value });
      label.value = ""; toast("Labelled"); await helpers.refresh();
    }),
    smallButton(helpers, "Take it off", async () => {
      await api("/api/labels/remove", { target: target.value, targetId: id.value.trim(), label: label.value });
      toast("Taken off"); await helpers.refresh();
    }));
  wrap.appendChild(adding);
  return wrap;
}

function workflowsSection(workflows, helpers) {
  const { el, api, toast, refresh } = helpers;
  const wrap = section(helpers, "Things that run themselves",
    "A saved list of steps the app works through on its own. It picks up where it left off, even after the app is closed.");
  if (!workflows.length) return empty(helpers, wrap, "Nothing saved yet.");
  for (const flow of workflows) {
    const card = el("div", undefined, "collab-card");
    card.appendChild(el("strong", flow.name));
    card.appendChild(el("p", flow.description || "No description", "collab-desc"));
    card.appendChild(el("p", `${statusWords[flow.status] ?? flow.status} — step ${Math.min(flow.cursor + 1, flow.steps.length)} of ${flow.steps.length}`, "collab-meta"));
    if (flow.question) card.appendChild(el("p", flow.question, "collab-question"));
    if (flow.error) card.appendChild(el("p", flow.error, "collab-error"));
    const row = el("div", undefined, "collab-row");
    row.appendChild(smallButton(helpers, flow.status === "waiting_approval" ? "Yes, carry on" : "Carry on", async () => {
      await api(`/api/workflows/${flow.id}/${flow.status === "idle" || flow.status === "completed" ? "run" : "resume"}`, {});
      toast("Started"); await refresh();
    }));
    row.appendChild(smallButton(helpers, "Stop for now", async () => { await api(`/api/workflows/${flow.id}/pause`, {}); await refresh(); }));
    card.appendChild(row);
    wrap.appendChild(card);
  }
  return wrap;
}

function queueSection(queue, helpers) {
  const { el, api, refresh } = helpers;
  const wrap = section(helpers, "Waiting to be done",
    "When as many tasks are already working as this computer is set to handle, the rest wait their turn instead of being turned away. What you ask for goes first.");
  const atOnce = el("input");
  Object.assign(atOnce, { type: "number", min: "1", max: "8", value: String(queue.settings?.atOnce ?? 3) });
  const setting = el("label", undefined, "collab-row");
  setting.appendChild(el("span", "Tasks at the same time"));
  setting.appendChild(atOnce);
  setting.appendChild(smallButton(helpers, "Save", async () => {
    await api("/api/queue/settings", { atOnce: Number(atOnce.value) }); await refresh();
  }));
  wrap.appendChild(setting);
  if (!queue.waiting?.length) return empty(helpers, wrap, "Nothing is waiting.");
  for (const entry of queue.waiting) {
    const card = el("div", undefined, "collab-card");
    card.appendChild(el("strong", `${entry.position}. ${entry.prompt.slice(0, 90)}`));
    card.appendChild(el("p", entry.status === "running" ? "Working now" : `Waiting — asked by ${entry.source === "owner" ? "you" : entry.source}`, "collab-meta"));
    card.appendChild(smallButton(helpers, entry.status === "running" ? "Stop it" : "Take it out of the line", async () => {
      await api(`/api/queue/${entry.id}/cancel`, {}); await refresh();
    }));
    wrap.appendChild(card);
  }
  return wrap;
}

function daysOffSection(calendar, helpers) {
  const { el, api, toast, refresh } = helpers;
  const settings = calendar.settings ?? {};
  const wrap = section(helpers, "Days off and quiet hours",
    "Holidays and your own days off, and the hours when messages should wait until morning. The holiday list is ordinary data you can correct.");
  const country = el("select");
  country.appendChild(new Option("No holiday list", ""));
  for (const item of calendar.countries ?? [])
    country.appendChild(new Option(`${item.name} (${item.days} days listed)`, item.code));
  country.value = settings.country ?? "";
  /* Wave 8: every control says what it is, so the row reads the same to the eye and to a
     screen reader, and the tick box sits beside its words instead of on a line of its own. */
  country.setAttribute("aria-label", "Which country's holidays to follow");
  const quiet = el("input"); quiet.type = "checkbox"; quiet.checked = Boolean(settings.quietHours?.enabled);
  const from = el("input"); from.type = "time"; from.value = settings.quietHours?.from ?? "21:00";
  from.setAttribute("aria-label", "Hold messages from");
  const to = el("input"); to.type = "time"; to.value = settings.quietHours?.to ?? "07:00";
  to.setAttribute("aria-label", "Hold messages until");
  const quietLabel = el("label", undefined, "check");
  quietLabel.append(quiet, document.createTextNode(" Hold messages overnight"));
  const row = el("div", undefined, "collab-row");
  row.append(el("span", "Holidays for"), country, quietLabel, el("span", "between"), from, el("span", "and"), to);
  wrap.appendChild(row);
  wrap.appendChild(smallButton(helpers, "Save", async () => {
    await api("/api/calendar", { ...settings, country: country.value,
      quietHours: { ...(settings.quietHours ?? {}), enabled: quiet.checked, from: from.value, to: to.value } });
    toast("Saved"); await refresh();
  }));
  return wrap;
}

function sharesSection(shares, helpers) {
  const { el, api, refresh } = helpers;
  const wrap = section(helpers, "Shared copies",
    "A read-only copy of one conversation, with anything that looks like a key blanked out. A link works on this computer only, needs its code, and is used once.");
  if (!shares.length) return empty(helpers, wrap, "Nothing shared. Open a conversation and choose Share a copy.");
  for (const share of shares) {
    const card = el("div", undefined, "collab-card");
    card.appendChild(el("strong", share.title || "Shared conversation"));
    card.appendChild(el("p", `${share.receipt.messagesShared} messages · ${share.receipt.secretsRemoved} blanked out · ${share.openedAt ? "already opened" : "not opened yet"} · stops working ${share.expiresAt}`, "collab-meta"));
    card.appendChild(smallButton(helpers, "Stop this link", async () => { await api(`/api/shares/${share.id}/revoke`, {}); await refresh(); }));
    wrap.appendChild(card);
  }
  return wrap;
}

function peopleSection(profile, helpers) {
  const { el, api, toast, refresh } = helpers;
  const wrap = section(helpers, "People who share this computer",
    "Someone else can have their own name and PIN. Their conversations and saved facts are kept apart from yours, and they cannot reach your secrets or projects. This is separation on one computer, not separate accounts.");
  wrap.appendChild(el("p", profile.active ? `Signed in as ${profile.active.name}` : "Signed in as the owner", "collab-meta"));
  for (const person of profile.all ?? []) {
    const card = el("div", undefined, "collab-card");
    card.appendChild(el("strong", person.name));
    const pin = el("input"); pin.type = "password"; pin.inputMode = "numeric"; pin.placeholder = "PIN"; pin.setAttribute("aria-label", `PIN for ${person.name}`);
    card.appendChild(pin);
    card.appendChild(smallButton(helpers, "Switch to this person", async () => {
      await api("/api/profiles/switch", { profileId: person.id, pin: pin.value });
      toast(`Switched to ${person.name}`); await refresh();
    }));
    if (profile.isOwner)
      card.appendChild(smallButton(helpers, "Remove", async () => { await api(`/api/profiles/${person.id}/remove`, {}); await refresh(); }));
    wrap.appendChild(card);
  }
  if (!profile.isOwner) {
    wrap.appendChild(smallButton(helpers, "Back to the owner", async () => {
      await api("/api/profiles/switch", { profileId: null }); await refresh();
    }));
    return wrap;
  }
  const name = el("input"); name.placeholder = "Their name"; name.maxLength = 40; name.setAttribute("aria-label", "Their name");
  const newPin = el("input"); newPin.type = "password"; newPin.inputMode = "numeric"; newPin.placeholder = "Four to eight digits"; newPin.setAttribute("aria-label", "Their PIN, four to eight digits");
  const adding = el("div", undefined, "collab-row");
  adding.append(name, newPin, smallButton(helpers, "Add them", async () => {
    await api("/api/profiles", { name: name.value, pin: newPin.value });
    name.value = ""; newPin.value = ""; toast("Added"); await refresh();
  }));
  wrap.appendChild(adding);
  return wrap;
}
