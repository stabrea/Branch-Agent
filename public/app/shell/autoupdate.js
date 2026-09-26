/* Update by itself (Settings › Notifications and Updates & about, the first-run offer): in the desktop app the window asks
   the engine what to do about updates (POST /api/comfort/update-plan) and has the desktop's updater look and install, the
   same path as the Update button (a checksum, a try on a copy of your work, a safety copy). A release whose install failed
   is not tried again by itself, and the engine says so once. Until the owner's choice has been read it counts as off, so
   nothing goes looking for an update that was not wanted. It imports nothing: main.js hands it the engine, the desktop
   bridge and the toast, and tests/update-failed-release.test.mjs hands it stand-ins for the desktop and the timers. */

const OFF_LOOK = 60_000; // how soon the owner's choice is read again while update by itself is off

/* How long until the next look: soon while it installs by itself, else by how often the channel ships. */
const interval = (notify) => notify.autoUpdate === "install" ? 30_000
  : notify.releaseChannel !== "stable" ? 5 * 60_000 : 60 * 60_000;

/* Which release the updater means, and the one whose install just failed (its status then carries the outcome). */
const about = (now) => ({ updaterPhase: now?.phase, ...(now?.release?.tag ? { updaterTag: now.release.tag } : {}),
  ...(now?.phase === "error" && now?.outcome && now?.release?.tag ? { failedTag: now.release.tag } : {}) });

export function autoUpdater({ desktop, api, toast, ready, timers = globalThis }) {
  let timer = null, busy = false;
  const schedule = (ms) => { timers.clearTimeout(timer); timer = timers.setTimeout(() => void look(), ms); };
  async function look() {
    if (busy) return;
    busy = true;
    let next = OFF_LOOK;
    try {
      const notify = (await api("comfort")).values?.notify;
      if (!notify || notify.autoUpdate === "off") return;
      next = interval(notify);
      let status = await desktop.updateStatus();
      let plan = await api("comfort/update-plan", about(status));
      if (plan.failed) toast(plan.failed);
      if (plan.step === "check") {
        status = await desktop.checkForUpdates();
        plan = await api("comfort/update-plan", { ...about(status), checked: true });
      }
      if (plan.step === "install") await desktop.installUpdate(true);
      else if (plan.mode === "check" && status?.phase === "available") toast(ready());
    } catch (error) {
      // A refused key stops the looking (every refused request counts against signing in); anything else, the next look tries again.
      if (error.status === 401 || error.status === 429) next = null;
      console.warn(error.message);
    } finally {
      busy = false;
      // The engine records when it last looked, so the next delay starts after this answer, from the latest choice.
      if (next !== null) schedule(next);
    }
  }
  return { look, busy: () => busy };
}
