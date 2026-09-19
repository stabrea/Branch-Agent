// datefmt 2.0.0 — see CHANGELOG.md
const pad = (n) => String(n).padStart(2, "0");

/** Formats a date. Pattern tokens: YYYY, MM, DD. */
export function formatDate(date, pattern) {
  return pattern
    .replace("YYYY", String(date.getUTCFullYear()))
    .replace("MM", pad(date.getUTCMonth() + 1))
    .replace("DD", pad(date.getUTCDate()));
}
