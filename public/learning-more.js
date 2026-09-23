/* R17-F: "Learning, deeper". Nine cards, each placed by public/layout.js through data-home, each
   with the owner's three-way switch, all starting off. Every control has a label and a one-line
   description (aria-describedby), and every word is behind a data-t key with French.

   settings:memory    Memory blocks, the timeline, finding conversations by meaning, lessons from
                      failed evaluation tasks, preferences from Claude Code and Codex, expiring and
                      labelled memories, reading note edits back, outside memory services
   customize:skills   How often each skill is used, and merging look-alikes */
import { api } from "/app.js";
import { t } from "/i18n.js";
import { segmented, dropdown } from "/control-makers.js";

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
/** A control with its label and a one-line description the control points at. */
const words = (tag, className, text) => (typeof text === "string" ? plain(tag, text, className) : make(tag, className, ...text));
/** Words are [key, english] (drawn again when the language changes) or a finished string (drawn with values). */
function described(id, labelWords, hintWords, control) {
  const label = words("label", "", labelWords);
  label.htmlFor = id;
  control.id = id;
  const note = words("p", "field-note", hintWords);
  note.id = `${id}-hint`;
  control.setAttribute("aria-describedby", note.id);
  return [label, control, note];
}
function input(tag, value = "", type = "") {
  const node = document.createElement(tag);
  if (type) node.type = type;
  if (type === "checkbox") node.checked = Boolean(value); else node.value = value;
  return node;
}
function select(options, value) {
  return dropdown({ id: "", options, value });
}
const tell = (node, error) => { delete node.dataset.t; node.textContent = error.message ?? String(error); };
const done = (node, key = "lmore.saved", english = "Saved.") => { node.dataset.t = key; node.textContent = say(key, english); };
function button(id, [key, english], [hintKey, hint], handler) {
  const node = make("button", "quiet-button", key, english);
  node.type = "button";
  node.addEventListener("click", async () => {
    node.disabled = true;
    try { await handler(); } finally { node.disabled = false; }
  });
  node.id = id;
  const note = make("p", "field-note", hintKey, hint);
  note.id = `${id}-hint`;
  node.setAttribute("aria-describedby", note.id);
  return [node, note];
}

const POSITIONS = [["off", "field.switch-off", "Off"], ["when-needed", "field.switch-when-needed", "When needed"], ["on", "field.switch-on", "On"]];
const SWITCH_HINT = ["lmore.switch.hint", "Off refuses; only when needed offers its tools when the work calls for them; on uses it from the start."];

function card(id, home, part, state, [titleKey, title], [purposeKey, purpose]) {
  const node = make("section", "card");
  node.id = id;
  node.dataset.home = home;
  node.append(make("h2", "", titleKey, title), make("p", "subtle", purposeKey, purpose));
  const status = make("p", "subtle");
  status.setAttribute("role", "status");
  const control = segmented({ id: `lmore-switch-${part}`, options: POSITIONS, value: state.modes[part], onChange: async (value) => {
    try { await api("learning-more/switch", { part, mode: value }); done(status); await drawCards(); } catch (error) { tell(status, error); }
  } });
  node.append(...described(`lmore-switch-${part}`, ["lmore.switch.label", "Use it"], SWITCH_HINT, control));
  return { node, status, on: state.modes[part] !== "off" };
}
const finish = (built) => { built.node.append(built.status); return built.node; };
const list = (items, render) => {
  const node = document.createElement("ul");
  node.className = "plain-list";
  for (const item of items) node.append(render(item));
  return node;
};

/* ---------- Memory blocks ---------- */
function blocksCard(state) {
  const built = card("lmore-blocks-card", "settings:memory", "blocks", state, ["lmore.blocks.title", "Memory blocks the assistant can edit"],
    ["lmore.blocks.purpose", "A few short, named notes kept in front of every conversation. The assistant keeps them current, within each one's size."]);
  if (!built.on) return finish(built);
  for (const block of state.blocks) {
    const box = input("textarea", block.value);
    box.maxLength = block.limit;
    const used = plain("p", say("lmore.blocks.used", `${block.value.length} of ${block.limit} characters`, { used: block.value.length, limit: block.limit }), "meta");
    box.addEventListener("input", () => { used.textContent = say("lmore.blocks.used", `${box.value.length} of ${block.limit} characters`, { used: box.value.length, limit: block.limit }); });
    built.node.append(plain("h4", block.label), ...described(`lmore-block-${block.label}`, ["lmore.blocks.value", "What it says"],
      block.label === "about-you" ? ["lmore.blocks.aboutHint", "Your about-you note from Settings; its size and whether it is shown are set there."] : ["lmore.blocks.valueHint", "The assistant sees this at the start of each conversation."], box), used,
      ...button(`lmore-block-save-${block.label}`, ["lmore.blocks.save", "Save this block"], ["lmore.blocks.saveHint", "Keeps your wording; key-like values are hidden."], async () => {
        try { await api("learning-more/blocks/edit", { label: block.label, action: "set", text: box.value }); done(built.status); } catch (error) { tell(built.status, error); }
      }));
  }
  const label = input("input");
  const size = input("input", "2000", "number");
  Object.assign(size, { min: "100", max: "8000" });
  built.node.append(make("h4", "", "lmore.blocks.new", "A new block"),
    ...described("lmore-block-label", ["lmore.blocks.label", "Name"], ["lmore.blocks.labelHint", "Lower-case letters, digits and dashes, such as project-goals."], label),
    ...described("lmore-block-size", ["lmore.blocks.size", "Size in characters"], ["lmore.blocks.sizeHint", "The block can never grow past this."], size),
    ...button("lmore-block-add", ["lmore.blocks.add", "Add the block"], ["lmore.blocks.addHint", "It starts empty; the assistant or you can fill it."], async () => {
      try { await api("learning-more/blocks", { label: label.value.trim(), limit: Number(size.value) }); done(built.status); await drawCards(); } catch (error) { tell(built.status, error); }
    }));
  return finish(built);
}

/* ---------- Curator ---------- */
async function curatorCard(state) {
  const built = card("lmore-curator-card", "customize:skills", "curator", state, ["lmore.curator.title", "How often each skill is used"],
    ["lmore.curator.purpose", "Counts from recent tasks, and skills that say much the same thing, which you can merge after seeing what would change."]);
  if (!built.on) return finish(built);
  const report = await api("learning-more/curator");
  built.node.append(list(report.skills, (skill) => plain("li", say("lmore.curator.uses", `${skill.name}: used in ${skill.uses} tasks`, { name: skill.name, uses: skill.uses }))));
  if (report.note) built.node.append(make("p", "field-note", "lmore.curator.partial", "Counted over recent tasks only."));
  for (const pair of report.overlaps) {
    const id = `${pair.a.id}-${pair.b.id}`.slice(0, 60);
    const preview = plain("pre", "", "meta");
    built.node.append(plain("p", `${pair.a.name} ~ ${pair.b.name} (${Math.round(pair.similarity * 100)}%)`),
      ...button(`lmore-dry-${id}`, ["lmore.curator.dry", "Show what a merge would change"], ["lmore.curator.dryHint", "Nothing changes; the first skill stays."], async () => {
        try { preview.textContent = (await api("learning-more/curator/dry-run", { keepId: pair.a.id, foldId: pair.b.id })).note; } catch (error) { tell(built.status, error); }
      }), preview,
      ...button(`lmore-merge-${id}`, ["lmore.curator.merge", "Suggest the merge"], ["lmore.curator.mergeHint", "Two suggestions wait in your review queue; nothing is switched off until you accept."], async () => {
        try { await api("learning-more/curator/merge", { keepId: pair.a.id, foldId: pair.b.id }); done(built.status, "lmore.curator.suggested", "Suggested. See the review queue."); } catch (error) { tell(built.status, error); }
      }));
  }
  return finish(built);
}

/* ---------- Journey ---------- */
async function journeyCard(state) {
  const built = card("lmore-journey-card", "settings:memory", "journey", state, ["lmore.journey.title", "A timeline of what was learned"],
    ["lmore.journey.purpose", "Facts saved and changed, skills written, your decisions, habits and lessons, newest first."]);
  if (!built.on) return finish(built);
  const { entries } = await api("learning-more/journey?limit=50");
  built.node.append(entries.length ? list(entries, (entry) => plain("li", `${entry.at.slice(0, 10)} · ${entry.title}: ${entry.detail}`))
    : make("p", "subtle", "lmore.journey.empty", "Nothing has been learned yet."));
  return finish(built);
}

/* ---------- Meaning search ---------- */
function meaningCard(state) {
  const built = card("lmore-meaning-card", "settings:memory", "meaning-search", state, ["lmore.meaning.title", "Finding past conversations by meaning"],
    ["lmore.meaning.purpose", "Finds what was meant even when other words were used. Without a way to compare meaning, it matches words."]);
  if (!built.on) return finish(built);
  const query = input("input");
  const role = select([["", "lmore.meaning.anyone", "Anyone"], ["user", "lmore.meaning.you", "You"], ["assistant", "lmore.meaning.assistant", "The assistant"]], "");
  const results = document.createElement("div");
  built.node.append(...described("lmore-meaning-query", ["lmore.meaning.query", "Look for"], ["lmore.meaning.queryHint", "Describe it in your own words."], query),
    ...described("lmore-meaning-role", ["lmore.meaning.role", "Said by"], ["lmore.meaning.roleHint", "Only messages from this side of the conversation."], role),
    ...button("lmore-meaning-go", ["lmore.meaning.go", "Search"], ["lmore.meaning.goHint", "Messages are compared the first time you search, which can take a moment."], async () => {
      try {
        const answer = await api("learning-more/search", { query: query.value, ...(role.value ? { role: role.value } : {}) });
        results.replaceChildren(list(answer.results, (hit) => plain("li", `${hit.sessionCreatedAt.slice(0, 10)} · ${hit.excerpt}`)));
      } catch (error) { tell(built.status, error); }
    }), results);
  if (!state.meaningReady) built.node.append(make("p", "field-note", "lmore.meaning.words", "No way to compare meaning is connected, so words are matched."));
  return finish(built);
}

/* ---------- Lessons ---------- */
async function lessonsCard(state) {
  const built = card("lmore-lessons-card", "settings:memory", "lessons", state, ["lmore.lessons.title", "Learning from failed evaluation tasks"],
    ["lmore.lessons.purpose", "A failed evaluation task leaves a lesson for you to approve. Approved lessons go on trial; those that help later are offered to remember, the rest are dropped."]);
  if (!built.on) return finish(built);
  const { lessons } = await api("learning-more/lessons");
  const waiting = lessons.filter((lesson) => lesson.status === "pending");
  if (waiting.length) built.node.append(make("h4", "", "lmore.lessons.waitingTitle", "Waiting for your yes"),
    make("p", "field-note", "lmore.lessons.waitingNote", "No task is shown a lesson until you approve it."), list(waiting, (lesson) => pendingLesson(lesson, built)));
  const rest = lessons.filter((lesson) => lesson.status !== "pending");
  built.node.append(rest.length ? list(rest, (lesson) => plain("li", `${say(`lmore.lessons.${lesson.status}`, lesson.status)} · ${lesson.passes}/${lesson.passes + lesson.failures} · ${lesson.text}`))
    : make("p", "subtle", "lmore.lessons.empty", "No lessons yet. Run an evaluation suite to start."),
  ...button("lmore-lessons-forget", ["lmore.lessons.forget", "Forget every lesson"], ["lmore.lessons.forgetHint", "Removes the lessons on trial and their counts; facts you already kept stay."], async () => {
    try { await api("learning-more/lessons/forget", { confirm: "forget" }); done(built.status); await drawCards(); } catch (error) { tell(built.status, error); }
  }));
  return finish(built);
}

/** A lesson waiting for the owner: its words, then a yes that puts it on trial and a no that drops it. */
function pendingLesson(lesson, built) {
  const item = plain("li", lesson.text);
  const decide = (approve) => async () => {
    try { await api("learning-more/lessons/decide", { id: lesson.id, approve }); done(built.status); await drawCards(); } catch (error) { tell(built.status, error); }
  };
  item.append(
    ...button(`lmore-lesson-approve-${lesson.id}`, ["lmore.lessons.approve", "Try this lesson"],
      ["lmore.lessons.approveHint", "Later evaluation tasks like this one are shown it, and it is kept only if it helps."], decide(true)),
    ...button(`lmore-lesson-decline-${lesson.id}`, ["lmore.lessons.decline", "Turn it down"],
      ["lmore.lessons.declineHint", "The lesson is dropped and never shown to a task."], decide(false)));
  return item;
}

/* ---------- Preferences from other assistants ---------- */
function sessionsCard(state) {
  const built = card("lmore-sessions-card", "settings:memory", "session-lessons", state, ["lmore.sessions.title", "Learning your preferences from Claude Code and Codex"],
    ["lmore.sessions.purpose", "Reads only what you typed in their chats, never their sign-ins, and shows every preference before anything is kept."]);
  if (!built.on) return finish(built);
  const { settings, folders } = state.sessions;
  for (const [source, key, english] of [["claude-code", "lmore.sessions.claude", "Claude Code chats"], ["codex", "lmore.sessions.codex", "Codex chats"]]) {
    const box = input("input", settings[source], "checkbox");
    box.addEventListener("change", async () => {
      try { await api("learning-more/sessions", { [source]: box.checked }); done(built.status); } catch (error) { tell(built.status, error); }
    });
    built.node.append(...described(`lmore-source-${source}`, [key, english],
      say("lmore.sessions.folder", `Read from ${folders[source]}`, { folder: folders[source] }), box));
  }
  const found = document.createElement("div");
  built.node.append(...button("lmore-sessions-scan", ["lmore.sessions.scan", "Look for preferences"], ["lmore.sessions.scanHint", "Nothing is kept by looking."], async () => {
    try { drawCandidates(found, (await api("learning-more/sessions/scan", {})).candidates, built.status); } catch (error) { tell(built.status, error); }
  }), found);
  return finish(built);
}
function drawCandidates(found, candidates, status) {
  const boxes = candidates.map((candidate) => {
    const box = input("input", false, "checkbox");
    box.value = candidate.id;
    return [candidate, box];
  });
  const rows = boxes.map(([candidate, box]) => described(`lmore-candidate-${candidate.id}`, candidate.text,
    say("lmore.sessions.seen", `Said in ${candidate.chats} chats`, { count: candidate.chats }), box));
  const chosen = () => boxes.filter(([, box]) => box.checked).map(([candidate]) => candidate.id);
  found.replaceChildren(...rows.flat(),
    ...(candidates.length ? [] : [make("p", "subtle", "lmore.sessions.none", "No preference came up in more than one chat.")]),
    ...button("lmore-sessions-keep", ["lmore.sessions.keep", "Keep the ones ticked"], ["lmore.sessions.keepHint", "Each is saved as a preference you can change or forget later."], async () => {
      try { await api("learning-more/sessions/keep", { ids: chosen() }); done(status); found.replaceChildren(); } catch (error) { tell(status, error); }
    }),
    ...button("lmore-sessions-decline", ["lmore.sessions.decline", "Never offer the ones ticked"], ["lmore.sessions.declineHint", "They are not shown again."], async () => {
      try { await api("learning-more/sessions/decline", { ids: chosen() }); done(status); found.replaceChildren(); } catch (error) { tell(status, error); }
    }));
}

/* ---------- Expiry and labels ---------- */
async function expiryCard(state) {
  const built = card("lmore-expiry-card", "settings:memory", "expiry", state, ["lmore.expiry.title", "Memories that expire, with labels and dates"],
    ["lmore.expiry.purpose", "A fact can carry labels and a date after which it is set aside, never deleted. Search by label and date."]);
  if (!built.on) return finish(built);
  const { tags } = await api("learning-more/memory/tags");
  const tag = input("input");
  const results = document.createElement("div");
  built.node.append(plain("p", tags.map((entry) => `${entry.tag} (${entry.count})`).join(", ") || say("lmore.expiry.noTags", "No labels yet.")),
    ...described("lmore-expiry-tag", ["lmore.expiry.tag", "Label"], ["lmore.expiry.tagHint", "Only facts with this label."], tag),
    ...button("lmore-expiry-find", ["lmore.expiry.find", "Find"], ["lmore.expiry.findHint", "Expired facts are left out."], async () => {
      try {
        const { facts } = await api("learning-more/memory/find", { tags: tag.value.trim() ? [tag.value.trim()] : [] });
        results.replaceChildren(list(facts, (fact) => plain("li", `${fact.text}${fact.expiresAt ? ` · ${fact.expiresAt.slice(0, 10)}` : ""}`)));
      } catch (error) { tell(built.status, error); }
    }), results);
  return finish(built);
}

/* ---------- Read-back and tidy instructions ---------- */
function readBackCard(state) {
  const built = card("lmore-readback-card", "settings:memory", "readback", state, ["lmore.readback.title", "Reading your edits to the memory notes back"],
    ["lmore.readback.purpose", "Edits you make in the memory folder become suggestions. You can also write how your notes should be tidied."]);
  if (!built.on) return finish(built);
  const words = input("textarea", state.readBack.tidyInstructions);
  words.maxLength = 2000;
  built.node.append(...described("lmore-tidy-words", ["lmore.readback.words", "How to tidy my notes"], ["lmore.readback.wordsHint", "In your own words, such as: merge notes about the same project."], words),
    ...button("lmore-tidy-save", ["lmore.readback.save", "Save the instructions"], ["lmore.readback.saveHint", "Used only when you ask for a tidy."], async () => {
      try { await api("learning-more/readback", { tidyInstructions: words.value }); done(built.status); } catch (error) { tell(built.status, error); }
    }),
    ...button("lmore-tidy-run", ["lmore.readback.run", "Tidy now"], ["lmore.readback.runHint", "Asks the model once; its ideas wait as suggestions."], async () => {
      try { const answer = await api("learning-more/readback/tidy", {}); delete built.status.dataset.t; built.status.textContent = answer.note; } catch (error) { tell(built.status, error); }
    }));
  return finish(built);
}

/* ---------- Outside memory services ---------- */
function providersCard(state) {
  const built = card("lmore-providers-card", "settings:memory", "providers", state, ["lmore.providers.title", "Outside memory services"],
    ["lmore.providers.purpose", "Also keep and recall things with Hindsight, Mem0 or Honcho. Branch's own memory always stays."]);
  if (!built.on) return finish(built);
  const current = state.providers;
  const active = select([["none", "lmore.providers.none", "None"], ["hindsight", "lmore.providers.hindsight", "Hindsight"], ["mem0", "lmore.providers.mem0", "Mem0 (your own server)"], ["honcho", "lmore.providers.honcho", "Honcho"]], current.active);
  const address = input("input", (current.active === "honcho" ? current.honcho.address : current.mem0.address) ?? "", "url");
  const secret = input("input", current.active === "honcho" ? current.honcho.secret : current.mem0.secret);
  built.node.append(...described("lmore-provider", ["lmore.providers.which", "Service"], ["lmore.providers.whichHint", "Hindsight uses the server set up under Hindsight."], active),
    ...described("lmore-provider-address", ["lmore.providers.address", "Server address"], ["lmore.providers.addressHint", "For Mem0 or Honcho; your network rules apply."], address),
    ...described("lmore-provider-secret", ["lmore.providers.secret", "Key name in the locker"], ["lmore.providers.secretHint", "The name of a saved key, never the key itself."], secret),
    ...button("lmore-provider-save", ["lmore.providers.save", "Save"], ["lmore.providers.saveHint", "Nothing is sent until the assistant keeps or recalls something."], async () => {
      const service = active.value === "honcho" ? "honcho" : "mem0";
      const details = active.value === "mem0" || active.value === "honcho" ? { [service]: { ...current[service], address: address.value.trim() || null, secret: secret.value.trim() } } : {};
      try { await api("learning-more/providers", { active: active.value, ...details }); done(built.status); await drawCards(); } catch (error) { tell(built.status, error); }
    }));
  return finish(built);
}

const BUILDERS = [["lmore-blocks-card", blocksCard], ["lmore-curator-card", curatorCard], ["lmore-journey-card", journeyCard],
  ["lmore-meaning-card", meaningCard], ["lmore-lessons-card", lessonsCard], ["lmore-sessions-card", sessionsCard],
  ["lmore-expiry-card", expiryCard], ["lmore-readback-card", readBackCard], ["lmore-providers-card", providersCard]];

async function drawCards() {
  let state;
  try { state = await api("learning-more"); } catch { return; }
  for (const [id, build] of BUILDERS) {
    try {
      const fresh = await build(state);
      const old = $(id);
      if (old) old.replaceWith(fresh); else document.body.append(fresh);
    } catch { /* one card failing leaves the rest of the window as it was */ }
  }
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

whenReady(() => { void drawCards(); });
