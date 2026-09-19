import { getUsr } from "./users.js";

export function profileTitle(id) {
  const user = getUsr(id);
  return user ? `Profile of ${user.name}` : "Unknown user";
}
