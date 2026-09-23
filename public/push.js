/**
 * FQ-surfaces.mobile-push: turning Web Push on and off for this device, and the small card in
 * Settings → Notifications that does it. What actually happens when a task finishes — the encryption,
 * who gets told, and honoring "This window only" (public/comfort.js) — lives on the server
 * (src/web-push.ts); this file only asks the browser for a subscription and hands it over.
 *
 * Never inside the desktop app: there is no worker there (public/web-ui.js, U6). Never over plain
 * http either: without a secure context the browser has no `PushManager` at all, so the card says so
 * instead of offering a button that can only fail.
 */
import { t, language } from "/i18n.js";

const desktop = new URLSearchParams(location.search).get("desktop") === "1" || Boolean(globalThis.branchDesktop);
const supported = !desktop && "serviceWorker" in navigator && "PushManager" in globalThis && isSecureContext;
const token = () => sessionStorage.getItem("branch-token") || "";

async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + token(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || t("push.failed"));
  return data;
}
/** `applicationServerKey` wants raw bytes, not the base64url string the API answers with. */
function bytesOf(base64url) {
  const padded = base64url.padEnd(base64url.length + ((4 - (base64url.length % 4)) % 4), "=").replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}
async function enable() {
  const registration = await navigator.serviceWorker.ready;
  const { key } = await api("push/vapid-key");
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytesOf(key) });
  const json = subscription.toJSON();
  try {
    await api("push/subscribe", { endpoint: json.endpoint, keys: json.keys, language: language() === "fr" ? "fr" : "en" });
  } catch (error) {
    // The server refused it, so nothing will ever be sent there: the browser lets go of it too.
    await subscription.unsubscribe().catch(() => undefined);
    throw error;
  }
  return subscription;
}
async function disable(subscription) {
  await subscription.unsubscribe().catch(() => undefined);
  await api("push/unsubscribe", { endpoint: subscription.endpoint }).catch(() => undefined);
}

function keyed(tag, key, className) {
  const node = document.createElement(tag);
  node.textContent = t(key);
  node.dataset.t = key;
  if (className) node.className = className;
  return node;
}
function buildCard() {
  const card = document.createElement("section");
  card.className = "card";
  card.id = "push-card";
  // A new screen says where it lives (public/layout.js sendHome); this is not the notify card, so
  // it is its own — a Boolean this browser holds is not one of comfort.js's saved switches.
  card.dataset.home = "settings:notifications";
  const status = document.createElement("p");
  status.className = "subtle";
  status.setAttribute("role", "status");
  const button = document.createElement("button");
  button.type = "button";
  card.append(keyed("h2", "push.title"), keyed("p", "push.lead", "subtle"), button, status);

  const draw = (subscription) => {
    const on = Boolean(subscription);
    button.textContent = t(on ? "push.turnOff" : "push.turnOn");
    button.dataset.t = on ? "push.turnOff" : "push.turnOn";
    status.textContent = t(on ? "push.statusOn" : "push.statusOff");
    status.dataset.t = on ? "push.statusOn" : "push.statusOff";
  };
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const existing = await currentSubscription();
      if (existing) { await disable(existing); draw(null); } else draw(await enable());
    } catch (error) {
      status.textContent = error.message;
      delete status.dataset.t;
    } finally {
      button.disabled = false;
    }
  });
  document.addEventListener("branch-language", () => currentSubscription().then(draw).catch(() => undefined));
  currentSubscription().then(draw).catch(() => draw(null));
  return card;
}

/**
 * A tapped notification with no window open opens one at /?push-session=<id> (public/service-worker.js).
 * The address is put back at once; the conversation opens as soon as the workspace is on screen,
 * after signing in when this new tab has to.
 */
function openTappedConversation() {
  const url = new URL(location.href);
  const sessionId = url.searchParams.get("push-session");
  if (!sessionId) return;
  url.searchParams.delete("push-session");
  history.replaceState(history.state, "", url);
  const workspace = document.getElementById("workspace");
  if (!workspace) return;
  const openWhenShown = () => {
    if (workspace.hidden || !token()) return false;
    document.dispatchEvent(new CustomEvent("branch-push-open", { detail: { runId: null, sessionId } }));
    return true;
  };
  if (openWhenShown()) return;
  const watcher = new MutationObserver(() => { if (openWhenShown()) watcher.disconnect(); });
  watcher.observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
}

if (typeof document !== "undefined" && !desktop) openTappedConversation();
if (typeof document !== "undefined" && supported) {
  document.body.append(buildCard());
  // A push the owner taps says which conversation it was about; opening it here is the page's job.
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "branch-push-open") return;
    window.focus();
    document.dispatchEvent(new CustomEvent("branch-push-open", { detail: event.data }));
  });
}
