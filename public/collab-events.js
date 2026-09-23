// Signed collaboration events ("Notes"): short notes a household member leaves for the others.
// Kept in its own file so it can be worked on beside collab.js without colliding with it. Data
// comes from state.collab.events (src/collab-server.ts's collabState, one request with the rest
// of the collab panel); sending a note calls the API directly and asks for a refresh.
import { t } from "./i18n.js"; // relative, so a test can import this file too; the same /i18n.js in the page

/** Builds the Notes section. `events` is state.collab.events: { events, rejected }. */
export function eventsSection(events, helpers) {
  const { el, api, toast, refresh } = helpers;
  const wrap = el("div", undefined, "collab-section");
  wrap.appendChild(el("h3", t("events.title")));
  wrap.appendChild(el("p", t("events.description"), "collab-desc"));
  const list = el("div", undefined, "collab-found");
  renderList(list, events, helpers);
  wrap.appendChild(list);
  const input = el("textarea");
  input.rows = 2;
  input.placeholder = t("events.placeholder");
  input.setAttribute("aria-label", t("events.placeholder"));
  input.maxLength = 4000;
  const send = el("button", t("events.send"), "collab-btn-small");
  send.type = "button";
  send.addEventListener("click", async () => {
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    try {
      await api("/api/collab/events", { kind: "note", payload: { text } });
      input.value = "";
      await refresh();
    } catch (error) { toast(error.message); }
    finally { send.disabled = false; }
  });
  const row = el("div", undefined, "collab-row");
  row.append(input, send);
  wrap.appendChild(row);
  return wrap;
}

function renderList(list, events, helpers) {
  const { el } = helpers;
  const items = events?.events ?? [];
  const rejected = events?.rejected ?? [];
  if (!items.length) list.appendChild(el("p", t("events.empty"), "collab-empty"));
  for (const event of items) {
    const card = el("div", undefined, "collab-card");
    const text = typeof event.payload?.text === "string" ? event.payload.text : JSON.stringify(event.payload);
    card.appendChild(el("p", text));
    card.appendChild(el("p", t("events.by", { name: event.member, when: relativeTime(event.at) }), "collab-meta"));
    list.appendChild(card);
  }
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
