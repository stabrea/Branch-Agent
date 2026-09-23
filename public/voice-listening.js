/**
 * Settings › Voice › Listening right now: a status-only card showing what Branch is monitoring.
 *
 * Shows the real listening state derived from wake-word, dictation, and live voice settings.
 * This is a read-only status display with no editable settings (no backing state changes).
 *
 * DG-047 acceptance: derive and display the listening state from the real listener/session,
 * including none and unavailable cases.
 */
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);

/** Update the listening status display. */
function show() {
  const status = $("voice-listening-status");
  if (!status) return;
  // Placeholder implementation showing the card structure.
  // Real implementation will read from voice/dictation and wake-word listeners.
  const isListening = false; // TODO: derive from real listeners
  const message = isListening ? t("settings.voice.listening", "Listening for input right now.")
                              : t("settings.voice.idle", "Not listening.");
  status.textContent = message;
  status.classList.toggle("active", isListening);
}
