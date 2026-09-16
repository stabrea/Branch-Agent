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
    if (!globalThis.confirm(`Forget the sign-in for "${profile.name}"? You would have to sign in again.`)) return;
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

void refresh();
