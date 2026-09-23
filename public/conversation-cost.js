/** The sample's quiet cost line. Unknown or partial prices are never presented as a total. */
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
async function api(path) {
  const response = await fetch("/api/" + path, {
    headers: { authorization: "Bearer " + (sessionStorage.getItem("branch-token") || "") },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
const session = () => $("conversation")?.dataset.sessionId || null;
const money = (value) =>
  value > 0 && value < 0.01 ? "< $0.01"
    : "$" + value.toFixed(2);

let generation = 0;
let showing = null;
export async function refreshCost() {
  const here = session();
  const current = ++generation;
  const line = $("conversation-cost");
  if (!line) return;
  if (showing !== here) { line.textContent = ""; showing = here; }
  if (!here || $("workspace")?.hidden) { line.textContent = ""; return; }
  try {
    const cost = await api(`sessions/${encodeURIComponent(here)}/cost`);
    if (current !== generation || here !== session()) return;
    line.textContent = typeof cost.amount !== "number" || !Number.isFinite(cost.amount) || cost.amount < 0
      ? "" : t("conversation.cost", { cost: money(cost.amount) });
  } catch { if (current === generation) line.textContent = ""; }
}
setInterval(() => void refreshCost(), 6000);
new MutationObserver(() => void refreshCost()).observe($("conversation"), { attributes: true, attributeFilter: ["data-session-id"] });
document.addEventListener("branch-profile", () => {
  showing = null;
  $("conversation-cost").textContent = "";
  void refreshCost();
});
document.addEventListener("branch-language", () => void refreshCost());
document.addEventListener("branch-run-finished", () => void refreshCost());
void refreshCost();
globalThis.branchConversationCost = { refresh: refreshCost };
