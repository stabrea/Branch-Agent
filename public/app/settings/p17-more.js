/* Pass 17's rows on the smaller Settings pages (prototype patch17b), each at its own level:
   Gateway › Never break opens the journal of updates tried, kept or rolled back (GET /api/never-break/journal);
   "Try a bad change" would break the running engine on purpose, so it stays greyed. Saved sign-ins › the password
   manager is chosen where the sign-ins are kept (security-held, greyed), shown pressed from the engine's own list of
   services. Every other row here has no readout in the window yet, so it is drawn and greyed. */
import { esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast, openDlg } from "../core/ui.js";
import { seg15 } from "./rows15.js";
import { demos17, demo17, row17, sec17, pill17 } from "./rows17.js";

/* ---------- Gateway ---------- */
export const gateway17 = (lv) => (lv < 1 ? "" : sec17("Never break",
  row17("Canary, journal and rollback", "Every change to how Branch runs is tried on a copy first; a bad one is rolled back by itself.", "Open the journal", "nbb17"))
  + sec17("Chat apps, in depth", demos17(["tgdepth", "delivery", "voicenote", "broadcast", "router", "hookaddr"])));

const ENDED = { activated: ["ok", "Kept"], superseded: ["ok", "Kept"], "rolled-back": ["warn", "Rolled back"], failed: ["warn", "Rolled back"] };
async function openJournal() {
  let entries;
  try { entries = (await api("never-break/journal")).entries ?? []; } catch (error) { toast(error.message); return; }
  const when = (at) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const rows = entries.map((e) => `<div class="prow"><span class="grow"><b>${esc(e.fromVersion)} → ${esc(e.toVersion)}</b><small>${esc(when(e.finishedAt ?? e.startedAt))}</small></span>${ENDED[e.state] ? pill17(...ENDED[e.state]) : ""}</div>`).join("");
  openDlg({ title: "Never break: the journal", wide: true, body: `<p class="lead-b17">Each change to how Branch runs starts on a copy. A small canary checks the engine still answers; if it doesn’t, the change is rolled back by itself.</p><div class="rows">${rows}</div>`,
    foot: '<button class="btn ghost" type="button" data-act="nbtryb17">Try a bad change</button><button class="btn" type="button" data-act="dlg-close">Close</button>' });
}

/* ---------- Saved sign-ins ---------- */
const VAULT = { bitwarden: "Bitwarden fills sign-ins; Branch never sees them.", onepassword: "1Password fills sign-ins; Branch never sees them.", windows: "Windows Credential Manager, on this computer only." };
export function secrets17(lv, services) {
  if (lv < 1) return "";
  const cur = ["bitwarden", "onepassword", "windows"].find((v) => (services ?? []).includes(v)) ?? null;
  return sec17("Where passwords come from", seg15("Password manager", cur ? VAULT[cur] : "", [["bitwarden", "Bitwarden"], ["onepassword", "1Password"], ["windows", "Windows"]], cur, "vaultb17")
    + demos17(["keys", "locker", "tokens"]));
}

/* ---------- the rest, by page ---------- */
export const computer17 = (lv) => (lv < 1 ? "" : sec17("Where scripts run, more", demos17(["troubleshoot", "bgproc", "screenwatch", "profiles", "devpick", "editor"]))
  + (lv >= 2 ? sec17("Limits, technical", demo17("jobobj")) : ""));
export const accounts17 = (lv) => (lv < 1 ? "" : sec17("Terms", demo17("terms")));
export const developer17 = (lv) => (lv < 2 ? "" : sec17("Build on Branch", demos17(["sdk", "cli", "events", "scopes", "tracing", "studies", "toolreport", "surfaces", "flowyaml"])));
export const updates17 = (lv) => (lv < 1 ? "" : sec17("Help and updates, more", demos17(["handbook", "updfix"])));
export const people17 = (lv) => (lv < 1 ? "" : sec17("Records", demo17("signed")));
export const voice17 = (lv) => (lv < 1 ? "" : sec17("Talking, more", demo17("voiceapprove")));
export const appearance17 = (lv) => (lv < 2 ? "" : sec17("Window, technical", demo17("frame")));
export const self17 = (lv) => (lv < 1 ? "" : sec17("Settings you can talk to", demos17(["talksettings", "learncore"])));

let started = false;
export function initMore17() {
  if (started) return;
  started = true;
  on("nbb17", () => openJournal());
  markLive(["nbb17"]);
}
