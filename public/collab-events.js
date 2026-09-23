// Signed collaboration events ("Notes"): short notes a household member leaves for the others.
// Kept in its own file so it can be worked on beside collab.js without colliding with it. Data
// comes from state.collab.events (src/collab-server.ts's collabState, one request with the rest
// of the collab panel); sending a note calls the API directly and asks for a refresh.
import { t } from "./i18n.js"; // relative, so a test can import this file too; the same /i18n.js in the page

/* The whole collab panel, this section included, is rebuilt from scratch every few seconds
   (public/app.js's refresh()). A half-written note must survive that: what is typed and whether
   the box had focus are kept here, at module scope, across rebuilds — the same reasoning
   showProfileBadge already uses for a PIN being typed. */
let draft = "";
let focused = false;

/** Builds the Notes section. `events` is state.collab.events: { events, rejected }; `profile` is
 *  state.collab.profile, so a note reads "Ada" or "The owner" rather than a bare member id. */
export function eventsSection(events, profile, helpers) {
  const { el, api, toast, refresh } = helpers;
  const wrap = el("div", undefined, "collab-section");
  wrap.appendChild(el("h3", t("events.title")));
  wrap.appendChild(el("p", t("events.description"), "collab-desc"));
  const list = el("div", undefined, "collab-found");
  renderList(list, events, profile, helpers);
  wrap.appendChild(list);
  const input = el("textarea");
  input.rows = 2;
  input.placeholder = t("events.placeholder");
  input.setAttribute("aria-label", t("events.placeholder"));
  input.maxLength = 4000;
  input.value = draft;
  input.addEventListener("input", () => { draft = input.value; });
  input.addEventListener("focus", () => { focused = true; });
  input.addEventListener("blur", () => { focused = false; });
  const send = el("button", t("events.send"), "collab-btn-small");
  send.type = "button";
  send.addEventListener("click", async () => {
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    try {
      await api("/api/collab/events", { kind: "note", payload: { text } });
      draft = ""; input.value = "";
      await refresh();
    } catch (error) { toast(error.message); }
    finally { send.disabled = false; }
  });
  const row = el("div", undefined, "collab-row");
  row.append(input, send);
  wrap.appendChild(row);
  // The box is rebuilt on every refresh; a person still typing keeps their place and their focus.
  // A microtask, not a frame: replaceChildren (public/app.js's renderCollab) finishes in the same
  // synchronous stretch as this call, and a keystroke that lands before a whole frame would go to
  // <body> and be lost.
  if (focused) queueMicrotask(() => {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  return wrap;
}

/** The name a note's byline shows: the owner is never called "you" here, since somebody else's
 *  profile can be the one looking at the panel. Anybody no longer on this computer shows their id. */
function memberName(member, profile) {
  if (member === "owner") return t("events.owner");
  return (profile?.all ?? []).find((person) => person.id === member)?.name ?? member;
}

function renderList(list, events, profile, helpers) {
  const { el } = helpers;
  const items = events?.events ?? [];
  const rejected = events?.rejected ?? [];
  if (!items.length) list.appendChild(el("p", t("events.empty"), "collab-empty"));
  for (const event of items) {
    const card = el("div", undefined, "collab-card");
    const text = typeof event.payload?.text === "string" ? event.payload.text : JSON.stringify(event.payload);
    card.appendChild(el("p", text));
    card.appendChild(el("p", t("events.by", { name: memberName(event.member, profile), when: relativeTime(event.at) }), "collab-meta"));
    list.appendChild(card);
  }
  // A note can fail to verify for two different reasons: it was changed after signing, or it was
  // signed by somebody who is no longer (or never was) part of this household. Both are folded
  // into one plain line, since either way the note is simply not shown as genuine.
  if (rejected.length) list.appendChild(el("p", t("events.rejected", { count: rejected.length }), "collab-meta"));
}

/** A plain "how long ago", the same shape trunks.js's own list already uses. */
function relativeTime(iso) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (minutes < 1) return t("events.ago.now");
  if (minutes < 60) return t("events.ago.minutes", { n: minutes });
  if (minutes < 1440) return t("events.ago.hours", { n: Math.round(minutes / 60) });
  return t("events.ago.days", { n: Math.round(minutes / 1440) });
}
