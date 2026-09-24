/**
 * Q111: a value put into one segment of a URL path. `encodeURIComponent` leaves "." and ".." as they are and
 * the URL parser then resolves them, so a value that is exactly one of those climbs out of its segment (to
 * the collection above, or further); an empty one leaves the collection itself. Each is refused; anything
 * else is encoded as before. `%2e` cannot get through: `encodeURIComponent` encodes the `%`.
 */
export function pathSegment(value: string): string {
  if (value === "" || value === "." || value === "..")
    throw new Error(`"${value}" cannot be used as one part of an address, so nothing was sent.`);
  return encodeURIComponent(value);
}
