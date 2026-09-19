import { getUsr } from "./users.js";

/** getUsr returns null for a missing id, so this is safe. */
export function isKnown(id) {
  return getUsr(id) !== null;
}
