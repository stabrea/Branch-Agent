/**
 * Q230 part 3: Settings › Backup › what a restore is waiting to hear about. A restore brings back a setting that can
 * change who Branch talks to, what it runs or how careful it is only on the owner's yes, group by group, and this
 * computer's own stays until then (src/restore-held.ts). This card is where that yes, or no, is given.
 */
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);

async function api(body) {
  const response = await fetch("/api/restore/held", {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || t("restoreHeld.failed"));
  return data;
}

function say(text) { $("restore-held-status").textContent = text; }

/** Q239: a held row's plain name, the Settings words when it has them, else its id. */
const nameOf = (detail) => (detail.nameT ? t(detail.nameT) : "") || detail.name || detail.id;
/** Q239: what the file would put in place, field by field, so a yes is never a blind one. */
function fieldsOf(details) {
  const box = document.createElement("div");
  box.className = "restore-held-fields";
  for (const detail of details) {
    const head = document.createElement("p");
    head.className = "meta";
    const plain = document.createElement("strong");
    plain.textContent = nameOf(detail);
    head.append(plain);
    // The id beside the plain name, once: a row with no plain name is already shown by its id.
    if (nameOf(detail) !== detail.id) head.append(" ", Object.assign(document.createElement("code"), { textContent: detail.id }));
    box.append(head);
    if (!detail.fields.length) {
      box.append(Object.assign(document.createElement("p"), { className: "meta", textContent: t("restoreHeld.nothingTelling") }));
      continue;
    }
    const list = document.createElement("ul");
    list.setAttribute("aria-label", t("restoreHeld.fromBackup"));
    for (const { field, value } of detail.fields) {
      const item = document.createElement("li");
      const key = document.createElement("code");
      key.textContent = field;
      item.append(key, `: ${value}`);
      list.append(item);
    }
    box.append(Object.assign(document.createElement("p"), { className: "meta", textContent: t("restoreHeld.fromBackup") }), list);
  }
  return box;
}

function draw(held) {
  const box = $("restore-held"), list = $("restore-held-list");
  box.hidden = !held.length;
  list.replaceChildren();
  $("restore-held-confirm").replaceChildren();
  for (const { group, ids, details } of held) {
    const row = document.createElement("li");
    row.className = "record restore-held-row";
    const name = document.createElement("code");
    name.textContent = group;
    const count = document.createElement("span");
    count.className = "meta";
    count.textContent = t("restoreHeld.items", { count: ids.length });
    const use = document.createElement("button");
    use.type = "button";
    use.textContent = t("restoreHeld.use");
    use.addEventListener("click", () => answer({ use: [group] }, t("restoreHeld.used", { group })));
    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "secondary";
    keep.textContent = t("restoreHeld.keep");
    keep.addEventListener("click", () => answer({ keep: [group] }, t("restoreHeld.kept", { group })));
    row.append(name, count, use, keep, fieldsOf(details ?? []));
    list.append(row);
  }
}

let groups = [];
async function load() {
  try { groups = (await api()).held; draw(groups); } catch { /* not the owner, or not signed in yet: nothing to show */ }
}
async function answer(body, done) {
  try { groups = (await api(body)).held; draw(groups); say(done); } catch (error) { say(error.message); }
}

// Q239: "Use all" says everything it would turn on first, and asks once more.
$("restore-held-use-all").addEventListener("click", () => {
  const confirm = $("restore-held-confirm");
  const yes = Object.assign(document.createElement("button"), { type: "button", textContent: t("restoreHeld.yesUseAll") });
  yes.addEventListener("click", () => answer({ use: groups.map((one) => one.group) }, t("restoreHeld.usedAll")));
  const no = Object.assign(document.createElement("button"), { type: "button", className: "secondary", textContent: t("restoreHeld.notNow") });
  no.addEventListener("click", () => confirm.replaceChildren());
  confirm.replaceChildren(Object.assign(document.createElement("p"), { textContent: t("restoreHeld.confirmAll") }),
    fieldsOf(groups.flatMap((one) => one.details ?? [])), yes, no);
});
$("restore-held-keep-all").addEventListener("click", () => answer({ keep: groups.map((one) => one.group) }, t("restoreHeld.keptAll")));
// Looked at whenever the card comes on screen, as the activity log is; a restore always restarts Branch first.
const seen = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) void load(); });
seen.observe($("backup-card"));
