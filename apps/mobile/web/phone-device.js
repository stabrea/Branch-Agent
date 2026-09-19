/**
 * mac7/phone-pairing: "Lend this phone to Branch" — pairing this phone as one of the owner's
 * devices (src/devices/), from the phone itself instead of from the computer.
 *
 * The owner presses *Pair a device* in Customize, Channels, Your devices. This card scans the square
 * it shows (or takes the address typed in), takes the six numbers, and asks the native side to do
 * the pairing. The phone's own key is made, kept and used only on the native side (iOS Keychain,
 * Android Keystore); this page never sees it, and nothing here is ever logged.
 *
 * The card also keeps the phone's own "never allow" list: things this phone refuses whatever Branch
 * switches on. It can only take away, and it is kept next to the key so a page cannot lose it.
 */
import { DEVICE_REFUSALS, keyCheck, readDeviceInvitation, readNever, sixDigits } from "/rules.js";
import { startScan } from "/scan.js";
import { $, describe, plugin, say, status } from "/phone-common.js";

/** The owner's words for each refusal, and why it is worth having. */
const REFUSAL_WORDS = {
  camera: ["phone.device.never.camera", "The camera", "No photo, whatever Branch asks."],
  screen: ["phone.device.never.screen", "A picture of the screen", "Nothing on this screen is sent."],
  listen: ["phone.device.never.listen", "The microphone", "No recording, whatever Branch asks."],
  run: ["phone.device.never.run", "Running programs", "Nothing is ever run on this phone."],
};

let invitation = null;
let stopScan = null;

/** Reads what was scanned or typed, and says plainly what is still missing. */
export function readDeviceAddress() {
  const typed = $("device-address").value.trim();
  if (!typed) { invitation = null; status("device-status", ""); return; }
  try {
    invitation = readDeviceInvitation(typed);
    status("device-status", "");
  } catch (error) {
    invitation = null;
    status("device-status", describe(error), true);
  }
}

export async function scanDevice() {
  const video = $("device-scan-view");
  video.hidden = false;
  status("device-status", say("phone.device.scanning", "Point the camera at the square on your computer."));
  try {
    await import("/vendor/jsqr.js");
    const decoder = globalThis.jsQR?.default ?? globalThis.jsQR;
    const scan = startScan(video, decoder);
    stopScan = scan.stop;
    const text = await scan.found;
    if (text) { $("device-address").value = text; readDeviceAddress(); $("device-code").focus(); }
  } catch {
    status("device-status", say("phone.device.noCamera", "The camera could not be opened. Type the address instead."), true);
  } finally {
    stopScan = null;
    video.hidden = true;
  }
}

/** Asks the native side to answer the invitation, then to wait for the owner's yes. */
export async function pairDevice() {
  readDeviceAddress();
  if (!invitation) { if (!$("device-address").value.trim()) status("device-status", say("phone.device.needAddress", "Scan the square first, or type the computer's address."), true); return; }
  let code;
  try { code = sixDigits($("device-code").value); } catch (error) { status("device-status", describe(error), true); return; }
  $("device-pair").disabled = true;
  status("device-status", await waitingWords());
  try {
    const never = readNever(await kept());
    const answer = await plugin.devicePair({ ...invitation, code, name: $("device-label").value.trim(), never });
    if (!answer?.paired) throw new Error(answer?.error || say("phone.device.failed", "That did not work. Make a new invitation on the computer."));
    $("device-code").value = "";
    status("device-status", say("phone.device.done", "This phone is on the list. Everything starts switched off; switch things on from your computer."));
  } catch (error) {
    status("device-status", describe(error), true);
  } finally {
    $("device-pair").disabled = false;
    await drawDevice();
  }
}

/**
 * mac7/residuals: while it waits, the phone shows the check code the computer shows beside its request,
 * made from this phone's own key, so the owner can compare the two before pressing Let it in.
 */
async function waitingWords() {
  const key = await plugin.deviceKey?.().catch(() => null);
  const check = key?.publicKey ? await keyCheck(globalThis.crypto, key.publicKey).catch(() => null) : null;
  return check
    ? say("phone.device.waitingCheck", "Waiting for you to press Let it in on your computer. Check code {check}: your computer shows the same code beside this phone's request.", { check })
    : say("phone.device.waiting", "Waiting for you to press Let it in on your computer.");
}

export async function unpairDevice() {
  await plugin.deviceForget();
  status("device-status", say("phone.device.forgotten", "This phone no longer lends anything. Remove it on your computer as well."));
  await drawDevice();
}

const kept = async () => readNever((await plugin.deviceStatus?.())?.never);

/** One refusal switched on or off. The list only ever takes away, so it needs no yes from Branch. */
async function changeRefusal(name, refused) {
  const now = new Set(await kept());
  if (refused) now.add(name); else now.delete(name);
  await plugin.deviceNever({ never: readNever([...now]) });
  await drawDevice();
}

function refusalRow(name, refused) {
  const [key, title, note] = REFUSAL_WORDS[name];
  const row = document.createElement("label");
  row.className = "phone-check";
  const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: refused });
  box.setAttribute("aria-describedby", `device-never-${name}`);
  box.addEventListener("change", () => void changeRefusal(name, box.checked));
  const words = document.createElement("span");
  const heading = Object.assign(document.createElement("strong"), { textContent: say(`${key}.title`, title) });
  heading.dataset.t = `${key}.title`;
  const why = Object.assign(document.createElement("small"), { id: `device-never-${name}`, textContent: say(`${key}.note`, note) });
  why.dataset.t = `${key}.note`;
  words.append(heading, why);
  row.append(box, words);
  return row;
}

/** Draws the card from what the native side knows. Nothing secret comes back from it. */
export async function drawDevice() {
  const state = (await plugin.deviceStatus?.().catch(() => null)) ?? { paired: false, never: [] };
  const never = readNever(state.never);
  $("device-never-list").replaceChildren(...DEVICE_REFUSALS.map((name) => refusalRow(name, never.includes(name))));
  $("device-paired").hidden = !state.paired;
  $("device-join").hidden = Boolean(state.paired);
  if (state.paired) $("device-with").textContent = say("phone.device.pairedWith", "Lending to {address}", { address: state.origin ?? "" });
  $("device-unable").hidden = state.canSign !== false;
  $("device-pair").disabled = state.canSign === false;
  return state;
}

/** Closes the camera when the card goes away, so it is never left running. */
export function closeDeviceScan() {
  stopScan?.();
  stopScan = null;
  $("device-scan-view").hidden = true;
}
