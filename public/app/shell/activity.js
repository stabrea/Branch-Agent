/* What is running now, as the engine lists it (GET /api/activity). Read again whenever the engine's state changes, which
   the event stream already triggers, so the status bar's count and its popover never guess. */

import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { renderNow } from "../core/dom.js";

export const ACT = { list: [], seen: null };
export const working = () => ACT.list.filter((a) => (a.task?.state ?? "working") === "working").length;

export async function readActivity() {
  if (!E.loaded || ACT.seen === E.state) return;
  ACT.seen = E.state;
  const before = JSON.stringify(ACT.list.map((a) => [a.runId, a.task?.state]));
  const list = await api("activity").catch(() => null);
  if (!Array.isArray(list)) return;
  ACT.list = list;
  if (JSON.stringify(list.map((a) => [a.runId, a.task?.state])) !== before) renderNow();
}
