import { t } from "./i18n.js";
// Settings → Websites you stay signed in to. Each saved sign-in is the cookies a website uses to
// remember you, kept scrambled on this computer. You type your password into a real browser window;
// the assistant is not part of that and never sees it.
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

const say = (message) => { $("browser-status").textContent = message; };

function row(profile, refresh) {
  const item = el("div", undefined, "item");
  const when = profile.savedAt ? new Date(profile.savedAt).toLocaleString() : "not signed in yet";
  item.append(el("h3", profile.name),
    el("p", profile.cookies ? `Remembered since ${when}` : "Made, but nobody has signed in yet"));
  const forget = el("button", "Forget this sign-in");
  forget.type = "button";
  forget.addEventListener("click", async () => {
    if (!globalThis.confirm(t("browser.confirm.forgetSignIn", { name: profile.name }))) return;
    try { await api("browser/profiles/remove", { name: profile.name }); say(`Forgot "${profile.name}".`); await refresh(); }
    catch (error) { say(error.message); }
  });
  item.append(forget);
  return item;
}

async function refresh() {
  const list = $("browser-profiles");
  if (!list) return;
  try {
    const data = await api("browser/profiles");
    list.replaceChildren(...(data.profiles.length
      ? data.profiles.map((profile) => row(profile, refresh))
      : [el("p", "No websites saved yet.", "subtle")]));
    $("browser-signin").disabled = !data.canSignIn;
    if (!data.canSignIn) say("Turn the browser on in your integration settings first, then come back here.");
  } catch (error) { say(error.message); }
}

$("browser-signin")?.addEventListener("click", async () => {
  const name = $("browser-name").value.trim(), url = $("browser-url").value.trim();
  if (!name || !url) { say("Give the sign-in a short name and the address of the website."); return; }
  $("browser-signin").disabled = true;
  say("A browser window is opening. Sign in there as you normally would, then close that window.");
  try {
    const done = await api("browser/signin", { name, url });
    say(`Saved "${done.signedIn.name}". Branch can now use that website while already signed in.`);
    $("browser-name").value = ""; $("browser-url").value = "";
    await refresh();
  } catch (error) { say(error.message); }
  finally { $("browser-signin").disabled = false; }
});

// Letting Branch work in the browser the person already has open. Nothing here is on by default,
// and the switch is read again by the assistant before every single use.
const attachSay = (message) => { $("browser-attach-status").textContent = message; };

async function refreshAttach() {
  if (!$("browser-attach-enabled")) return;
  try {
    const { settings, refusedSites } = await api("browser/attach");
    $("browser-attach-enabled").checked = settings.enabled;
    $("browser-attach-port").value = String(settings.port);
    $("browser-attach-run").value = settings.runId || "";
    $("browser-attach-refused").value = (settings.extraRefusedHosts || []).join("\n");
    attachSay(settings.enabled
      ? `On${settings.runId ? ` for task ${settings.runId}` : ""}. It turns itself off fifteen minutes after you switch it on. ${refusedSites} banking and password websites are refused outright.`
      : "Off. Branch uses its own fresh browser, which no website knows you in.");
  } catch (error) { attachSay(error.message); }
}

async function saveAttach() {
  const port = Number($("browser-attach-port").value) || 9222;
  try {
    const extraRefusedHosts = $("browser-attach-refused").value.split(/[\n,]/).map((line) => line.trim()).filter(Boolean);
    await api("browser/attach", { enabled: $("browser-attach-enabled").checked, port,
      runId: $("browser-attach-run").value.trim(), extraRefusedHosts });
    await refreshAttach();
  } catch (error) { attachSay(error.message); }
}

$("browser-attach-enabled")?.addEventListener("change", saveAttach);
$("browser-attach-port")?.addEventListener("change", saveAttach);
$("browser-attach-run")?.addEventListener("change", saveAttach);
$("browser-attach-refused")?.addEventListener("change", saveAttach);

void refresh();
void refreshAttach();
