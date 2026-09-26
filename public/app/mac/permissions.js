/* This Mac / This PC permissions: system permission status and request buttons. */

import { esc } from "../core/dom.js";
import { $, paint } from "../core/dom.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";
import { say } from "../core/words.js";

const PERMS_MAC = [
  { id: "accessibility", icon: "cursor", name: "Accessibility", desc: "Clicking and typing in other apps", how: "pane" },
  { id: "screen", icon: "screen", name: "Screen Recording", desc: "Seeing the screen, so a Trunk can find what to click", how: "pane" },
  { id: "automation", icon: "wand", name: "Automation", desc: "Controlling Mail, Finder, Safari and other apps", how: "pane" },
  { id: "disk", icon: "disk", name: "Full Disk Access", desc: "Reading beyond Documents, Desktop and Downloads", how: "pane" },
  { id: "microphone", icon: "mic", name: "Microphone", desc: "Talking to Branch and the wake word", how: "prompt" },
  { id: "camera", icon: "camera", name: "Camera", desc: "Photos and scanning a code", how: "prompt" },
  { id: "notifications", icon: "bell", name: "Notifications", desc: "Telling you when a Trunk needs you", how: "prompt" }
];

const PERMS_PC = [
  { id: "microphone", icon: "mic", name: "Microphone", desc: "Talking to Branch", how: "prompt" },
  { id: "camera", icon: "camera", name: "Camera", desc: "Photos and scanning a code", how: "prompt" },
  { id: "notifications", icon: "bell", name: "Notifications", desc: "Telling you when you're needed", how: "prompt" }
];

export function init() {
  markLive(["perm-allow", "perm-settings"]);
  on("perm-allow", (el) => requestPermission(el.dataset.p));
  on("perm-settings", (el) => openSystemSettings(el.dataset.p));
}

export function permissionsSection() {
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
  const perms = isMac ? PERMS_MAC : PERMS_PC;

  return `<div>
    <h3 data-css="margin-top:0">${t("window.settings.mac-permissions.this-value", { value: isMac ? "Mac" : "PC" })}</h3>
    <p data-css="color:var(--ink-2);font-size:13px;margin-bottom:16px">
      ${isMac
        ? t("window.settings.mac-permissions.macos-keeps-these-in-system-settings")
        : t("window.settings.mac-permissions.windows-asks-for-very-little-seeing")
      }
    </p>
    <div data-css="display:flex;flex-direction:column;gap:8px">${
      perms.map(p => `<div data-css="display:flex;align-items:center;gap:12px;padding:8px;border-radius:8px;background:var(--fill)">
        <span data-css="width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:6px;background:var(--raise)">⚙️</span>
        <div data-css="flex:1">
          <div data-css="font-weight:500">${esc(say(p.name))}</div>
          <div data-css="font-size:13px;color:var(--ink-2)">${esc(say(p.desc))}</div>
        </div>
        <span class="pill" data-css="background:var(--ink-3);color:var(--bg);padding:4px 8px;border-radius:999px;font-size:12px;white-space:nowrap">${t("window.settings.permissions.not-yet")}</span>
      </div>`).join("")
    }</div>
  </div>`;
}

export function mountPermissions(root) {
  if (!root) return;
  paint(root, permissionsSection());
}

function requestPermission(permId) {
  // Permissions can't be requested from web; in the real Electron app, this would call systemPreferences.askForMediaAccess()
  console.log(`Would request permission: ${permId}`);
}

function openSystemSettings(permId) {
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
  const urls = {
    accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
    disk: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
    microphone: isMac ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone" : "ms-settings:privacy-microphone",
    camera: isMac ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera" : "ms-settings:privacy-webcam",
    notifications: isMac ? "x-apple.systempreferences:com.apple.preference.notifications" : "ms-settings:notifications"
  };
  const url = urls[permId];
  if (url && window.branchDesktop?.openExternal) {
    window.branchDesktop.openExternal(url);
  }
}
