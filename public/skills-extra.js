// Skills screen, wave 4: packaging a skill as one file, opening a package someone sent, newer
// versions of skills that came from a registry, suggestions from recent tasks, and plugins.
const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
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
const fill = (id, rows, render, empty) => {
  const target = $(id);
  if (!target) return;
  target.replaceChildren(...(rows.length ? rows.map(render) : [el("p", empty, "subtle")]));
};
const say = (id, message) => { const node = $(id); if (node) node.textContent = message; };

let pending = null;

async function loadSkillChoices() {
  const select = $("skill-package-which");
  if (!select) return;
  // A package whose tools could not be put back this time is worth saying out loud.
  api("skills/packages").then(({ problems }) => {
    if (problems?.length) say("skill-package-status", problems.map((problem) => `${problem.skill} could not be loaded: ${problem.error}`).join(" "));
  }).catch(() => undefined);
  const state = await api("state").catch(() => ({ skills: [] }));
  const chosen = select.value;
  select.replaceChildren(...(state.skills || []).map((skill) => {
    const option = el("option", skill.name);
    option.value = skill.id;
    return option;
  }));
  if (chosen) select.value = chosen;
}

async function saveAsPackage() {
  const skillId = $("skill-package-which").value;
  const author = $("skill-package-author").value.trim();
  if (!skillId) return say("skill-package-status", "Install a skill above first, then choose it here.");
  if (!author) return say("skill-package-status", "Put your name in the box first; a package says who made it.");
  try {
    const file = await api(`skills/${skillId}/pack`, { author, packageVersion: "1.0.0" });
    const link = document.createElement("a");
    link.href = "data:application/octet-stream;base64," + file.base64;
    link.download = file.filename;
    link.click();
    say("skill-package-status", `Saved ${file.filename}. You can send that file to anyone running Branch.`);
  } catch (error) { say("skill-package-status", error.message); }
}

async function openPackage(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  try {
    const preview = await api("skills/package/inspect", { file: btoa(binary) });
    pending = btoa(binary);
    fill("skill-package-preview", preview.permissions, (asked) => el("p", asked.why), "It asks for nothing.");
    $("skill-package-preview").prepend(el("strong", `${preview.manifest.name} ${preview.manifest.packageVersion} by ${preview.manifest.author}`));
    $("skill-package-install").hidden = false;
    say("skill-package-status", "Read what it asks for, then install it if you are happy.");
  } catch (error) { pending = null; $("skill-package-install").hidden = true; say("skill-package-status", error.message); }
}

async function installPackage() {
  if (!pending) return;
  try {
    await api("skills/package/install", { file: pending, approve: true });
    pending = null;
    $("skill-package-install").hidden = true;
    $("skill-package-preview").replaceChildren();
    say("skill-package-status", "Installed. The skill is switched off until you turn it on in the list above.");
  } catch (error) { say("skill-package-status", error.message); }
}

/** FQ-automation.metrics: the running counts an installed package's own metrics.json asked to be kept. */
async function loadPackageMetrics() {
  try {
    const { packages } = await api("skills/packages");
    const withMetrics = packages.filter((entry) => entry.metrics?.length);
    fill("package-metrics-list", withMetrics, (entry) => {
      const row = el("div", undefined, "card");
      row.append(el("strong", entry.name));
      for (const point of entry.metrics) {
        const errors = point.errorsTotal ? `, ${point.errorsTotal} failed` : "";
        row.append(el("p", `${point.description}: ${point.callsTotal} call${point.callsTotal === 1 ? "" : "s"}${errors}${point.callsTotal ? `, ${point.avgMs}ms average` : ""}`, "meta"));
      }
      return row;
    }, "No installed package declares a metrics.json yet.");
  } catch (error) { say("package-metrics-status", error.message); }
}

async function loadUpdates() {
  try {
    const { updates } = await api("registry/updates");
    say("skill-updates-summary", updates.length
      ? `${updates.length} skill${updates.length === 1 ? " has" : "s have"} a newer version.`
      : "Every skill you installed from a registry is up to date.");
    fill("skill-updates-list", updates, (update) => {
      const row = el("div", undefined, "card");
      row.append(el("strong", update.name),
        el("p", `${update.registryName} · ${update.from ?? "unknown"} → ${update.to} · ${update.signed === "checked" ? "signature checked" : "not signed"}`, "meta"));
      if (update.changelog) row.append(el("p", update.changelog, "subtle"));
      const take = el("button", "Take the new version");
      take.type = "button";
      take.addEventListener("click", async () => {
        try { await api("registry/update", { skillId: update.skillId }); say("skill-updates-summary", `${update.name} is now on ${update.to}. Use "Go back" if it is worse.`); await loadUpdates(); }
        catch (error) { say("skill-updates-summary", error.message); }
      });
      const back = el("button", "Go back to the old one");
      back.type = "button";
      back.addEventListener("click", async () => {
        try { await api("registry/rollback", { skillId: update.skillId }); say("skill-updates-summary", `${update.name} is back on the version you had.`); }
        catch (error) { say("skill-updates-summary", error.message); }
      });
      row.append(take, back);
      return row;
    }, "Nothing to update.");
  } catch (error) { say("skill-updates-summary", error.message); }
}

async function loadSuggestions() {
  try {
    const { suggestions, tasksRead } = await api("skills/suggest");
    fill("skill-suggest-list", suggestions, (entry) => {
      const row = el("div", undefined, "card");
      row.append(el("strong", entry.name), el("p", entry.description, "subtle"),
        el("p", `${entry.source === "installed" ? "You have this one, switched off" : `From ${entry.registry}`} · matched ${entry.tasks} recent task${entry.tasks === 1 ? "" : "s"} on: ${entry.matched.join(", ")}`, "meta"));
      return row;
    }, tasksRead ? "Nothing in your recent tasks matched a skill you are not already using." : "No recent tasks to read yet.");
  } catch { fill("skill-suggest-list", [], () => el("p"), "Suggestions are not available right now."); }
}

async function loadPlugins() {
  try {
    const { plugins, problems } = await api("plugins");
    if (problems?.length) say("plugins-status", problems.map((problem) => `${problem.id} could not be loaded: ${problem.error}`).join(" "));
    fill("plugins-list", plugins, (plugin) => {
      const row = el("div", undefined, "card");
      row.append(el("strong", plugin.summary?.name ?? plugin.id),
        el("p", plugin.enabled ? "On. Its tools are in the catalog." : "Off. Nothing from this file is loaded.", "meta"));
      if (plugin.summary?.description) row.append(el("p", plugin.summary.description, "subtle"));
      const look = el("button", "See what it would add");
      look.type = "button";
      look.addEventListener("click", async () => {
        try {
          const summary = await api(`plugins/${plugin.id}/inspect`, {});
          say("plugins-status", `${summary.name} adds ${summary.tools.map((tool) => tool.name).join(", ") || "no tools"} and needs ${summary.permissions.join(", ") || "nothing"}.`);
        } catch (error) { say("plugins-status", error.message); }
      });
      const toggle = el("button", plugin.enabled ? "Switch it off" : "Switch it on");
      toggle.type = "button";
      toggle.addEventListener("click", async () => {
        try { await api(`plugins/${plugin.id}/${plugin.enabled ? "disable" : "enable"}`, {}); await loadPlugins(); say("plugins-status", `${plugin.id} is ${plugin.enabled ? "off" : "on"}.`); }
        catch (error) { say("plugins-status", error.message); }
      });
      row.append(look, toggle);
      return row;
    }, "No plugin files found. A developer puts <name>.mjs in the plugins folder beside your data.");
  } catch (error) { say("plugins-status", error.message); }
}

$("skill-package-save")?.addEventListener("click", saveAsPackage);
$("skill-package-open")?.addEventListener("click", () => $("skill-package-file").click());
$("skill-package-file")?.addEventListener("change", (event) => { const file = event.target.files?.[0]; if (file) void openPackage(file); event.target.value = ""; });
$("skill-package-install")?.addEventListener("click", installPackage);
const refreshSkillsScreen = () => { void loadSkillChoices(); void loadUpdates(); void loadSuggestions(); void loadPlugins(); void loadPackageMetrics(); };
/* Skills and Plugins both live under Customize now (public/layout.js says when either opens). */
document.addEventListener("branch-place", (event) => {
  if (["skills", "customize:skills", "customize:plugins"].includes(event.detail.view)) refreshSkillsScreen();
});
if (!document.getElementById("skills")?.hidden) refreshSkillsScreen();
