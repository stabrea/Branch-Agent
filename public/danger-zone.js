/**
 * mac7/clean-uninstall: the danger zone, last in Settings.
 *
 * It asks the server what removing Branch would take away, and draws that list with real sizes
 * before anything goes: Branch itself, the programs it downloaded to run models, the models, the
 * folder holding conversations and settings, the entry that starts it when you sign in, and the
 * `branch` command. Anything outside Branch is listed apart, with the honest note that Branch
 * cannot take it away. Keeping the conversations is a separate choice from removing everything.
 *
 * The button stays off until the owner has typed the product's own name, so a misclick cannot pass,
 * and the yes carries back the exact list that was shown. Every word goes through a key.
 */
import { t, formatNumber } from "/i18n.js";
import { api, toast } from "/app.js";

const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
const keyed = (tag, key, className, values) => {
  const node = el(tag, t(key, values), className);
  if (values) node.dataset.tKey = key; else node.dataset.t = key;
  return node;
};

/** Bytes in plain words: nothing at all, megabytes, or gigabytes with one decimal. */
function size(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024 ** 2) return t("danger.size.nothing");
  if (value < 1024 ** 3) return t("danger.size.mb", { mb: formatNumber(Math.round(value / 1024 ** 2)) });
  return t("danger.size.gb", { gb: formatNumber(Math.round((value / 1024 ** 3) * 10) / 10) });
}

let survey = null;

function drawItems() {
  const list = $("danger-list");
  list.replaceChildren();
  for (const item of survey.items) {
    const row = el("div", undefined, "danger-row");
    row.append(el("strong", item.what));
    row.append(el("p", item.path, "meta"));
    row.append(el("p", item.goes ? t("danger.item.goes", { size: size(item.bytes) }) : t("danger.item.kept", { size: size(item.bytes) }), "subtle"));
    list.append(row);
  }
  $("danger-total").textContent = t("danger.total", { size: size(survey.totalBytes) });
}

function drawLeft() {
  const box = $("danger-left");
  box.replaceChildren();
  if (!survey.left.length) return;
  box.append(keyed("h3", "danger.left.title"));
  for (const item of survey.left) {
    const row = el("div", undefined, "danger-row");
    row.append(el("strong", item.what));
    row.append(el("p", item.path, "meta"));
    row.append(el("p", item.why, "subtle"));
    box.append(row);
  }
}

/** Asks what would go, and redraws. Looking changes nothing on this computer. */
export async function drawDangerZone() {
  const card = $("danger-zone");
  if (!card) return;
  try {
    survey = await api("remove-branch/plan", { keepConversations: $("danger-keep").checked });
  } catch (error) {
    survey = null;
    $("danger-status").textContent = error.message;
    $("danger-remove").disabled = true;
    return;
  }
  if (survey.refusal || survey.instead) {
    $("danger-status").textContent = survey.refusal || survey.instead;
    $("danger-list").replaceChildren();
    $("danger-left").replaceChildren();
    $("danger-total").textContent = "";
    $("danger-remove").disabled = true;
    return;
  }
  $("danger-status").textContent = "";
  drawItems();
  drawLeft();
  checkTyped();
}

function checkTyped() {
  const typed = $("danger-confirm").value.trim();
  $("danger-remove").disabled = !survey || Boolean(survey.refusal) || typed !== (survey?.confirmPhrase ?? "");
}

$("danger-confirm")?.addEventListener("input", checkTyped);
$("danger-keep")?.addEventListener("change", () => { void drawDangerZone(); });
$("danger-remove")?.addEventListener("click", async () => {
  if (!survey) return;
  $("danger-remove").disabled = true;
  $("danger-status").textContent = t("danger.removing");
  try {
    const done = await api("remove-branch", {
      keepConversations: $("danger-keep").checked,
      confirm: $("danger-confirm").value.trim(),
      agreedSurvey: survey.fingerprint,
    });
    $("danger-status").textContent = done.lines.join(" ");
  } catch (error) {
    toast(error.message);
    $("danger-status").textContent = error.message;
    await drawDangerZone();
  }
});

if ($("danger-zone")) {
  const signedIn = () => { try { return Boolean(sessionStorage.getItem("branch-token")); } catch { return false; } };
  const draw = () => { if (signedIn()) void drawDangerZone(); };
  draw();
  document.addEventListener("branch-language", draw);
  /* The page loads before the owner signs in, so the card is drawn again each time it is opened. */
  document.addEventListener("branch-place", (event) => { if (String(event.detail?.view ?? "").startsWith("settings")) draw(); });
  new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) draw(); }).observe($("danger-zone"));
  const workspace = $("workspace");
  if (workspace) new MutationObserver(() => { if (!workspace.hidden) draw(); }).observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
}
