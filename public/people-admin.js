/**
 * bucket 19: the owner's card for people signing in from their own device, on Settings → General
 * beside "people on this computer" (docs/places.md). It sets the switch (off by default) and the
 * checks everybody passes, shows who is signed in where, makes one-time codes, links identity
 * services, groups people, and shares a conversation for reading or for joining in.
 */
import { t } from "/i18n.js";

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
/** A node whose words come from the language file; a name the owner typed ("" key) is shown as it is. */
const keyed = (tag, key, words, className, values) => {
  if (!key) { const named = el(tag, words, className); named.dataset.given = ""; return named; }
  const node = el(tag, t(key, values) === key ? words : t(key, values), className);
  // Words with values in them are drawn again when the language changes, so they keep their key apart.
  if (values) node.dataset.tDrawn = key; else node.dataset.t = key;
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
/** A key's words, or the English given while the language file does not have them. */
const say = (key, words) => (t(key) === key ? words : t(key));
function field(id, key, words, control) {
  control.id = id;
  const label = keyed("label", key, words);
  label.htmlFor = id;
  return [label, control];
}
function select(options, value) {
  const node = el("select");
  for (const [optionValue, key, words] of options) {
    const option = keyed("option", key, words);
    option.value = optionValue;
    option.selected = optionValue === value;
    node.append(option);
  }
  return node;
}
function tick(id, key, words, checked) {
  const box = el("input");
  box.type = "checkbox";
  box.id = id;
  box.checked = checked;
  // The words sit in a span of their own, so changing the language never wipes the tick box out.
  const label = el("label");
  label.append(box, keyed("span", key, words));
  label.htmlFor = id;
  return { label, box };
}
const quiet = (key, words, onClick) => {
  const button = keyed("button", key, words, "quiet-button");
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
};

/* DG-180: each finer part of the card is one box the Settings levels can find (public/settings-index.js names it), so
   Regular shows the switch alone, as the approved sample does, and "N more" counts each part. */
const part = (name, nodes) => {
  const box = el("div", undefined, "people-part");
  box.dataset.sgPart = name;
  box.append(...nodes);
  return box;
};

/* DG-180: a part the sample does not draw at Regular, shown from this level up (the Settings levels hide it below). */
const leveled = (level, nodes) => {
  const box = el("div", undefined, "people-part");
  box.dataset.level = level;
  box.append(...nodes);
  return box;
};

const modes = [
  ["off", "field.switch-off", "Off"],
  ["when-needed", "field.switch-when-needed", "When needed"],
  ["on", "field.switch-on", "On"],
];
const methods = [
  ["pin", "people.admin.method.pin", "Their PIN"],
  ["passkey", "people.admin.method.passkey", "A passkey on their device"],
  ["oidc", "people.admin.method.oidc", "An identity service you linked"],
];
const kinds = ["read", "files", "commands", "browse", "message", "spend", "settings"];

function switchSection(state, act) {
  const mode = select(modes, state.settings.mode);
  const chain = methods.map(([id, key, words]) => ({ id, ...tick(`people-chain-${id}`, key, words, state.settings.chain.includes(id)) }));
  const hours = el("input");
  hours.type = "number"; hours.min = "1"; hours.max = "168";
  hours.value = String(Math.round(state.settings.sessionMinutes / 60));
  /* DG-180: the switch saves as it changes, as the sample's does, so Regular shows it alone; Save, for the hours and
     the checks below, shows with them. Only the switch is sent: what is typed below and not saved stays unsaved.
     A save that fails puts the switch back to what is saved and says so, as DG-181's file switches do. */
  mode.addEventListener("change", async () => {
    await act("people/settings", { mode: mode.value }, () => {
      mode.value = state.settings.mode;
      return say("people.admin.mode-not-saved", "That change was not saved, so the switch is back where it was.");
    });
    document.getElementById("people-admin-mode")?.focus();
  });
  const save = keyed("button", "people.admin.save", "Save");
  save.type = "button";
  save.id = "people-admin-save";
  save.dataset.level = "advanced";
  save.addEventListener("click", () => act("people/settings", {
    mode: mode.value, chain: chain.filter((c) => c.box.checked).map((c) => c.id),
    sessionMinutes: Math.max(5, Math.round(Number(hours.value) * 60)),
  }));
  return [
    ...field("people-admin-mode", "people.admin.mode", "Let people sign in from their own device", mode),
    keyed("p", "people.admin.mode-note", "They open this computer's address followed by /people. Each person sees only their own conversations and what you share.", "field-note"),
    part("people-chain", [keyed("p", "people.admin.chain", "Everybody passes all of these", "meta"), ...chain.map((c) => c.label)]),
    ...field("people-admin-hours", "people.admin.hours", "Stay signed in for (hours)", hours),
    save,
  ];
}

function personRow(person, state, act) {
  const row = el("div", undefined, "item");
  row.dataset.person = person.id;
  row.append(el("strong", person.name));
  row.append(keyed("p", "people.admin.person-state", `${person.signedIn.length} sign-in(s), ${person.passkeys} passkey(s)`, "field-note",
    { signins: person.signedIn.length, passkeys: person.passkeys }));
  const code = el("p", undefined, "meta");
  code.setAttribute("aria-live", "polite");
  row.append(
    quiet("people.admin.code", "Make a one-time code", async () => {
      const made = await api(`people/${person.id}/reset-code`, {});
      code.textContent = t("people.admin.code-made", { code: made.code });
    }),
    quiet("people.admin.sign-out", "Sign out everywhere", () => act(`people/${person.id}/sign-out`, {})),
    code,
  );
  return row;
}

function providerSection(state, act) {
  const preset = select([["", "people.admin.preset.own", "Your own service"],
    ...Object.entries(state.presets).map(([id, p]) => [id, "", p.label])], "");
  const inputs = Object.fromEntries(["id", "label", "issuer", "clientId", "clientSecretName"].map((name) => [name, el("input")]));
  preset.addEventListener("change", () => {
    const chosen = state.presets[preset.value];
    if (!chosen) return;
    inputs.id.value = preset.value; inputs.label.value = chosen.label; inputs.issuer.value = chosen.issuer;
  });
  const add = quiet("people.admin.provider.add", "Add this service", () => act("people/settings", {
    providers: [...state.settings.providers.filter((p) => p.id !== inputs.id.value), {
      id: inputs.id.value.trim(), label: inputs.label.value.trim(), issuer: inputs.issuer.value.trim(), clientId: inputs.clientId.value.trim(),
      ...(inputs.clientSecretName.value.trim() ? { clientSecretName: inputs.clientSecretName.value.trim() } : {}),
    }],
  }));
  const list = state.settings.providers.map((p) => {
    const row = el("div", `${p.label} (${p.issuer})`, "item");
    row.append(quiet("people.admin.remove", "Remove", () => act("people/settings", { providers: state.settings.providers.filter((x) => x.id !== p.id) })));
    return row;
  });
  return [part("people-providers", [
    keyed("p", "people.admin.providers", "Identity services", "meta"),
    keyed("p", "people.admin.providers-note", `Register ${location.origin}${state.redirectPath} as the return address with the service.`, "field-note", { address: location.origin + state.redirectPath }),
    ...list,
    ...field("people-provider-preset", "people.admin.provider.preset", "Start from", preset),
    ...field("people-provider-id", "people.admin.provider.id", "Short name", inputs.id),
    ...field("people-provider-label", "people.admin.provider.label", "Name shown on the button", inputs.label),
    ...field("people-provider-issuer", "people.admin.provider.issuer", "Issuer address", inputs.issuer),
    ...field("people-provider-client", "people.admin.provider.client", "Client id", inputs.clientId),
    ...field("people-provider-secret", "people.admin.provider.secret", "Client secret's name in the locker (if the service needs one)", inputs.clientSecretName),
    add,
  ]), part("people-links", linkSection(state, act))];
}

function linkSection(state, act) {
  const person = select(state.people.map((p) => [p.id, "", p.name]), "");
  const provider = select(state.settings.providers.map((p) => [p.id, "", p.label]), "");
  const email = el("input");
  email.type = "email";
  const add = quiet("people.admin.link.add", "Link this account", () => act("people/settings", {
    links: [...state.settings.links, { provider: provider.value, profileId: person.value, email: email.value.trim() }],
  }));
  const list = state.settings.links.map((link) => {
    const who = state.people.find((p) => p.id === link.profileId)?.name ?? "?";
    const row = el("div", `${who} — ${link.provider}: ${link.email ?? link.subject}`, "item");
    row.append(quiet("people.admin.remove", "Remove", () => act("people/settings", { links: state.settings.links.filter((x) => x !== link) })));
    return row;
  });
  // Integration review: an email only suggests an account; the owner confirms it once, by its id at the service.
  const waiting = (state.waiting ?? []).map((found) => {
    const who = state.people.find((p) => p.id === found.profileId)?.name ?? "?";
    const row = el("div", `${who} — ${found.provider}: ${found.email}`, "item");
    row.append(quiet("people.admin.link.confirm", "Confirm this account", () => act("people/links/confirm",
      { provider: found.provider, profileId: found.profileId, subject: found.subject })));
    return row;
  });
  return [
    keyed("p", "people.admin.links", "Accounts linked to a person. An email address only suggests an account: the first time it is used, confirm it here.", "meta"), ...list,
    ...(waiting.length ? [keyed("p", "people.admin.link.waiting", "Waiting for you to confirm", "meta"), ...waiting] : []),
    ...field("people-link-person", "people.admin.link.person", "Person", person),
    ...field("people-link-provider", "people.admin.link.provider", "Service", provider),
    ...field("people-link-email", "people.admin.link.email", "Their email address at that service", email),
    add,
  ];
}

function groupSection(state, act) {
  const name = el("input");
  const members = state.people.map((p) => ({ id: p.id, ...tick(`people-group-member-${p.id}`, "", p.name, false) }));
  const allowed = kinds.map((kind) => ({ kind, ...tick(`people-group-kind-${kind}`, `people.admin.kind.${kind}`, kind, kind === "read") }));
  const add = quiet("people.admin.group.add", "Save this group", () => act("people/groups", {
    name: name.value.trim(), members: members.filter((m) => m.box.checked).map((m) => m.id),
    categories: allowed.filter((a) => a.box.checked).map((a) => a.kind),
  }));
  const list = state.groups.map((group) => {
    const row = el("div", `${group.name}: ${group.members.map((id) => state.people.find((p) => p.id === id)?.name ?? "?").join(", ")}`, "item");
    row.append(quiet("people.admin.remove", "Remove", () => act(`people/groups/${group.id}/remove`, {})));
    return row;
  });
  return [
    keyed("p", "people.admin.groups", "Groups", "meta"),
    keyed("p", "people.admin.groups-note", "Being in a group can only take things away: a member is held to their own role and to every group they are in.", "field-note"),
    ...list, ...field("people-group-name", "people.admin.group.name", "Group name", name),
    keyed("p", "people.admin.group.members", "Members", "meta"), ...members.map((m) => m.label),
    keyed("p", "people.admin.group.kinds", "What members may have Branch do", "meta"), ...allowed.map((a) => a.label),
    add,
  ];
}

function shareSection(state, sessions, act) {
  const conversation = select(sessions.map((s) => [s.id, "", (s.opening || s.id).slice(0, 60)]), "");
  const subject = select([...state.people.map((p) => [`profile:${p.id}`, "", p.name]),
    ...state.groups.map((g) => [`group:${g.id}#member`, "", g.name])], "");
  const relation = select([["viewer", "people.admin.share.viewer", "May read it"], ["driver", "people.admin.share.driver", "May also write in it"]], "viewer");
  const add = quiet("people.admin.share.add", "Share", () => act("people/shares", {
    object: `conversation:${conversation.value}`, relation: relation.value, subject: subject.value,
  }));
  const list = state.shares.map((tuple) => {
    const row = el("div", `${tuple.object.slice(13, 21)} — ${tuple.relation} — ${tuple.subject}`, "item");
    row.append(quiet("people.admin.remove", "Remove", () => act("people/shares/remove", tuple)));
    return row;
  });
  return [
    keyed("p", "people.admin.shares", "Shared conversations", "meta"),
    ...list,
    ...field("people-share-conversation", "people.admin.share.conversation", "Conversation", conversation),
    ...field("people-share-subject", "people.admin.share.subject", "With", subject),
    ...field("people-share-relation", "people.admin.share.relation", "They", relation),
    add,
  ];
}

function buildCard(state, sessions) {
  const card = el("section", undefined, "card");
  card.id = "people-signin-admin";
  card.dataset.home = "settings:general";
  const said = el("p", undefined, "meta");
  said.setAttribute("aria-live", "polite");
  /** Sends a change and draws the card again from what was saved; a failure is said, after what `failed` puts back. */
  const act = async (path, body, failed) => {
    try { await api(path, body); await drawPeopleAdmin(); }
    catch (error) { said.textContent = failed ? `${failed()} ${error.message}` : error.message; }
  };
  /* DG-180: the section's heading and line above say the card's title and purpose word for word, and the sample says
     them once: the title is read aloud only (a screen-reader-only h2, as DG-183's cards), and the card has no sentence. */
  card.append(keyed("h2", "people.admin.title", "Signing in from other devices", "sr-only"),
    ...switchSection(state, act), said,
    leveled("advanced", [keyed("p", "people.admin.people", "People", "meta"),
      ...(state.people.length ? state.people.map((p) => personRow(p, state, act))
        : [keyed("p", "people.admin.nobody", "Nobody else uses this computer yet. Add somebody under People first.", "subtle")])]),
    ...providerSection(state, act), part("people-groups", groupSection(state, act)), part("people-share", shareSection(state, sessions, act)));
  return card;
}

/** Draws the card; public/layout.js moves it to Settings → General. */
export async function drawPeopleAdmin() {
  let state, sessions = [];
  try { state = await api("people/settings"); } catch { return; }
  try { sessions = (await api("sessions?limit=50")).sessions ?? []; } catch { /* no conversations to offer */ }
  const open = document.getElementById("people-signin-admin");
  const next = buildCard(state, sessions);
  if (open) open.replaceWith(next); else document.body.append(next);
}

if (typeof document !== "undefined") {
  globalThis.branchPeopleReady = () => { drawPeopleAdmin().catch(() => {}); };
  document.addEventListener("branch-language", () => { drawPeopleAdmin().catch(() => {}); });
  drawPeopleAdmin().catch(() => {});
}
