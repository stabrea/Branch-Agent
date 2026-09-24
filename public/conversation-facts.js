/**
 * DG-101: the sample's line under the message box says how much of the model's room this conversation's next
 * request takes ("Context used 18%", a chip beside Ask first and Temporary, public/composer-grown.js) and, at its
 * far end, what the conversation has probably cost so far. It replaces the old meter bar and its popover, which the
 * sample has no place for. A cost that is not known for every task is never shown as a total: the line then says
 * nothing about money.
 */
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";
async function api(path) {
  const response = await fetch("/api/" + path, {
    headers: { authorization: "Bearer " + (sessionStorage.getItem("branch-token") || "") },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
const session = () => $("conversation")?.dataset.sessionId || null;
const money = (value) => (value > 0 && value < 0.01 ? "< $0.01" : "$" + value.toFixed(2));

/** The chip's small ring, drawn the way the limits glance draws its own (public/usage-glance.js). */
function ring(percent) {
  const r = 9, round = 2 * Math.PI * r;
  const box = document.createElementNS(SVG, "svg");
  for (const [name, value] of Object.entries({ width: 14, height: 14, viewBox: "0 0 22 22", "aria-hidden": "true", class: "glance-ring" })) box.setAttribute(name, String(value));
  const circle = (className, extra = {}) => {
    const node = document.createElementNS(SVG, "circle");
    for (const [name, value] of Object.entries({ cx: 11, cy: 11, r, fill: "none", "stroke-width": 3, class: className, ...extra })) node.setAttribute(name, String(value));
    return node;
  };
  box.append(circle("glance-ring-track"), circle("glance-ring-arc", { "stroke-linecap": "round", transform: "rotate(-90 11 11)",
    "stroke-dasharray": String(round), "stroke-dashoffset": String(round * (1 - percent / 100)) }));
  return box;
}

/** What the line last showed, kept when a refresh fails so it never flickers to nothing. */
let shown = { here: null, share: 0, cost: null };
function paint() {
  const chip = document.querySelector(".lx-foot-context");
  if (chip) {
    chip.replaceChildren(ring(shown.share), document.createTextNode(t("composer.contextUsed", { share: shown.share })));
    chip.dataset.share = String(shown.share);
  }
  const line = $("conversation-cost");
  if (line) line.textContent = typeof shown.cost === "number" ? t("conversation.cost", { cost: money(shown.cost) }) : "";
}

let generation = 0;
/** Refreshes both facts from the conversation on screen; safe to call as often as you like. */
export async function refreshFacts() {
  const here = session(), mine = ++generation;
  if (here !== shown.here) { shown = { here, share: 0, cost: null }; paint(); }
  if (!here || $("workspace")?.hidden) return;
  try {
    const [room, cost] = await Promise.all([api(`sessions/${here}/context`), api(`sessions/${here}/cost`)]);
    if (mine !== generation || here !== session()) return;
    const used = Math.max(0, Number(room.instructions) + Number(room.tools) + Number(room.conversation));
    const share = Math.max(0, Math.min(100, Math.round((used / (Number(room.limit) || 128000)) * 100)));
    const amount = typeof cost.amount === "number" && Number.isFinite(cost.amount) && cost.amount >= 0 ? cost.amount : null;
    shown = { here, share, cost: amount };
    paint();
  } catch { /* the line keeps what it last showed */ }
}

setInterval(() => void refreshFacts(), 6000);
new MutationObserver(() => void refreshFacts()).observe($("conversation"), { attributes: true, attributeFilter: ["data-session-id"] });
document.addEventListener("branch-language", paint);
document.addEventListener("branch-profile", () => { shown = { here: null, share: 0, cost: null }; void refreshFacts(); });
void refreshFacts();
globalThis.branchConversationFacts = { refresh: refreshFacts };
