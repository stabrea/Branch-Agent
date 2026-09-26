/* Settings › Permissions › App lock (prototype patch17b: Off, After 15 min, Always), from the engine:
   GET /api/lock says whether a PIN is set (never the PIN), the quiet minutes and lock-on-open.
   Off removes the PIN: POST /api/lock/pin { pin: null, current }, which the engine refuses without the PIN set now.
   After 15 min and Always first set a PIN when none is set (POST /api/lock/pin { pin }), then save the lock's settings
   whole (POST /api/lock/settings replaces them: idleMinutes, secretsWhileLocked, lockOnOpen).
   Change asks for the PIN set now and a new one (POST /api/lock/pin { pin, current }).
   A typed PIN is read from its field, the field is emptied, and it goes only into that one request; nothing keeps it.
   The engine counts wrong PINs here exactly as on the lock screen: every fifth wrong one waits. */
import { esc, render } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast, openDlg, closeDlg, $ } from "../core/ui.js";

const L = { lock: null };

async function load() {
  try { L.lock = await api("lock"); } catch (error) { toast(error.message); }
  render();
}

/* Which of the three the engine is on; none pressed when it has a PIN and neither quiet minutes nor lock-on-open. */
function current(lock) {
  if (!lock) return null;
  if (!lock.pinSet) return "off";
  if (lock.lockOnOpen) return "pin";
  return lock.idleMinutes > 0 ? "quiet" : null;
}
const quietMinutes = (lock) => (lock?.idleMinutes > 0 ? lock.idleMinutes : 15);

export function applockRow() {
  const lock = L.lock, cur = current(lock), n = quietMinutes(lock);
  const sub = cur === "off" ? "Anyone at this computer can open Branch." : cur === "quiet" ? `Locks after ${n} quiet minutes; your PIN opens it.`
    : cur === "pin" ? "Asks for your PIN every time it opens." : "";
  const opts = [["off", "Off"], ["quiet", `After ${n} min`], ["pin", "Always"]];
  const seg = `<span class="seg" role="group" aria-label="App lock">${opts.map(([v, l]) => `<button type="button" aria-pressed="${cur === v}" data-act="applockb17" data-v="${esc(v)}">${esc(l)}</button>`).join("")}</span>`;
  const change = lock?.pinSet ? '<button class="btn sm" type="button" data-act="applockchgb17">Change</button>' : "";
  return `<div class="ctl"><b>App lock</b><span class="right applock-b17">${seg}${change}</span><small>${esc(sub)}</small></div>`;
}

const field = (id, label, hint = "") => `<div class="field"><label for="${id}">${esc(label)}</label><input class="inp" id="${id}" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div>${hint ? `<p class="hint" data-css="margin:0">${esc(hint)}</p>` : ""}`;
const foot = (act, label, v = "") => `<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="${act}" data-v="${esc(v)}">${esc(label)}</button>`;
/* Reads a field and empties it at once, so the PIN lives only as long as the request that carries it. */
function take(box) {
  const value = box?.value ?? "";
  if (box) box.value = "";
  return value;
}

function choose(el) {
  const want = el.dataset.v, lock = L.lock;
  if (!lock || want === current(lock)) return;
  if (want === "off") return openDlg({ title: "App lock", body: field("pin-cur-b17", "PIN", "Five wrong tries wait five minutes."), foot: foot("applockoffb17", "Remove") });
  if (!lock.pinSet) return openDlg({ title: "App lock", body: field("pin-new-b17", "PIN", "Four to eight digits, kept on this computer."), foot: foot("applocksetb17", "Save", want) });
  saveMode(want);
}

async function saveMode(want) {
  const lock = L.lock;
  const next = { idleMinutes: want === "quiet" ? quietMinutes(lock) : lock.idleMinutes, secretsWhileLocked: lock.secretsWhileLocked, lockOnOpen: want === "pin" };
  try { await api("lock/settings", next); } catch (error) { toast(error.message); return; }
  await load();
  toast(want === "pin" ? "Branch asks for your PIN every time it opens." : `Branch locks after ${next.idleMinutes} quiet minutes.`);
}

async function setPin(el) {
  const pin = take($("#pin-new-b17"));
  try { await api("lock/pin", { pin }); } catch (error) { toast(error.message); return; }
  closeDlg();
  await load();
  await saveMode(el.dataset.v);
}

async function removePin() {
  const current = take($("#pin-cur-b17"));
  try { await api("lock/pin", { pin: null, current }); } catch (error) { toast(error.message); return; }
  closeDlg();
  await load();
  toast("App lock off.");
}

function openChange() {
  openDlg({ title: "App lock", body: field("pin-cur-b17", "The owner’s PIN", "Five wrong tries wait five minutes.") + field("pin-new-b17", "PIN", "Four to eight digits, kept on this computer."),
    foot: foot("applockchgokb17", "Save") });
}
async function changePin() {
  const current = take($("#pin-cur-b17")), pin = take($("#pin-new-b17"));
  try { await api("lock/pin", { pin, current }); } catch (error) { toast(error.message); return; }
  closeDlg();
  await load();
}

let started = false;
export function initApplock() {
  if (started) return;
  started = true;
  on("applockb17", (el) => choose(el));
  on("applocksetb17", (el) => setPin(el));
  on("applockoffb17", () => removePin());
  on("applockchgb17", () => openChange());
  on("applockchgokb17", () => changePin());
  markLive(["applockb17", "applocksetb17", "applockoffb17", "applockchgb17", "applockchgokb17", "sw:pin-cur-b17", "sw:pin-new-b17"]);
  load();
}
