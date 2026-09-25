/* Which features the engine can do today, keyed by the action name in design doc Appendix A (switches by "sw:<id>").
   live = wired to the engine; anything not live is drawn in place, greyed out, with "Coming soon" (contract rule 6).
   FEATURES holds the audit's verdicts; each area also calls markLive() for the controls it wires, from its own file,
   so no two builders edit this list at once. */

export const FEATURES = {};
const LIVE = new Set(["dlg-close", "view", "ptab"]);

export function markLive(ids) { for (const id of ids) LIVE.add(id); }
export const isLive = (id) => LIVE.has(id) || FEATURES[id] === "live";

function soon(el) {
  el.setAttribute("aria-disabled", "true");
  el.classList.add("soon");
  el.dataset.tip = "Coming soon";
  el.tabIndex = -1;
}

/* After a draw: every control that is not live gets the one greyed-out treatment. */
export function greyOut(root) {
  for (const el of root.querySelectorAll("[data-act]")) if (!isLive(el.dataset.act)) soon(el);
  for (const el of root.querySelectorAll("input[data-sw], select[data-sw]")) {
    if (isLive("sw:" + (el.id || el.dataset.sw))) continue;
    soon(el);
    el.disabled = true;
  }
}
