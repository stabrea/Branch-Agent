/* Pausing a Trunk, or all of them (src/trunks/pause.ts): POST /api/trunks/{id}/pause|resume and
   POST /api/trunks/pause-all|resume-all. A paused Trunk starts nothing new; a task it is running finishes, unless the
   owner stops it too ({now: true}). That choice is offered only while the engine says a Trunk is working
   (GET /api/trunks `running`: tasks running as that Trunk), in the prototype's own words. The engine writes each pause in the activity log. */

import { esc } from "../core/dom.js";
import { E, refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { openDlg, closeDlg, closePop, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";

const trunkById = (id) => E.trunks.find((t) => t.id === id);
export const allPaused = () => E.trunks.length > 0 && E.trunks.every((t) => t.paused);

/* The two ways to pause something that is working: let its task finish, or stop it now. */
function choose(title, target) {
  const pick = (now, words) => `<button type="button" class="upd-o15" data-act="pause-go" data-target="${esc(target)}" data-now="${now}"><b>${words}</b></button>`;
  openDlg({ title, body: `<div class="upd15">${pick("0", "Let them finish first")}${pick("1", "Stop the current task")}</div>` });
}

async function send(target, now) {
  closePop();
  closeDlg();
  try {
    if (target === "all") {
      await api("trunks/pause-all", { now });
      toast("All Trunks paused. Nothing new starts.");
    } else {
      const { trunk } = await api(`trunks/${encodeURIComponent(target)}/pause`, { now });
      toast(`${trunk.name} is paused and won’t start anything new.`);
    }
    await refresh();
  } catch (error) { toast(error.message); }
}

async function pauseTrunk(id) {
  closePop();
  const t = trunkById(id);
  if (!t) return;
  if (!t.paused && t.running > 0) return choose("Pause this Trunk", id);
  if (!t.paused) return send(id, false);
  try {
    await api(`trunks/${encodeURIComponent(id)}/resume`, {});
    toast(`${t.name} is back.`);
    await refresh();
  } catch (error) { toast(error.message); }
}

async function pauseAll() {
  closePop();
  if (!allPaused() && E.trunks.some((t) => !t.paused && t.running > 0)) return choose("Pause all Trunks", "all");
  if (!allPaused()) return send("all", false);
  try {
    await api("trunks/resume-all", {});
    toast("All Trunks are back.");
    await refresh();
  } catch (error) { toast(error.message); }
}

export function initPause() {
  markLive(["pausetrunk", "pauseall", "pause-go"]);
  on("pausetrunk", (el) => pauseTrunk(el.dataset.id));
  on("pauseall", () => pauseAll());
  on("pause-go", (el) => send(el.dataset.target, el.dataset.now === "1"));
}
