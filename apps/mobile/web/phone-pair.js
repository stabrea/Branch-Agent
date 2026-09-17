/** Connecting to a Branch (scan or paste, then six numbers) and unlocking. */
import { readInvitation } from "/rules.js";
import { startScan } from "/scan.js";
import { $, describe, phone, plugin, say, status } from "/phone-common.js";

let invitation = null;

export function readAddress() {
  try {
    invitation = readInvitation($("address").value);
    const note = invitation.offerId ? "" : say("phone.pair.needCode", "That is the address. Scan the square code too, so this phone can be let in.");
    status("pair-status", note, !invitation.offerId);
  } catch (error) {
    invitation = null;
    status("pair-status", describe(error), true);
  }
}

export async function scan() {
  const video = $("scan-view");
  video.hidden = false;
  status("pair-status", say("phone.pair.scanning", "Point the camera at the square code on your computer."));
  try {
    await import("/vendor/jsqr.js");
    const decoder = globalThis.jsQR?.default ?? globalThis.jsQR;
    const text = await startScan(video, decoder).found;
    if (text) { $("address").value = text; readAddress(); $("code").focus(); }
  } catch {
    status("pair-status", say("phone.pair.noCamera", "The camera could not be opened. Paste the address instead."), true);
  } finally {
    video.hidden = true;
  }
}

export async function pair(onPaired) {
  readAddress();
  if (!invitation) return;
  $("pair").disabled = true;
  status("pair-status", say("phone.pair.connecting", "Connecting…"));
  try {
    await phone.vault.pair(invitation, $("code").value, $("device-name").value);
    $("code").value = "";
    status("pair-status", "");
    await onPaired();
  } catch (error) {
    status("pair-status", describe(error), true);
  } finally {
    $("pair").disabled = false;
  }
}

export async function unlock(onUnlocked) {
  status("lock-status", "");
  const result = await plugin.unlock({ reason: say("phone.lock.reason", "Unlock Branch") }).catch(() => ({ unlocked: false }));
  if (result?.unlocked) await onUnlocked();
  else status("lock-status", say("phone.lock.failed", "Not unlocked. Try again."), true);
}
