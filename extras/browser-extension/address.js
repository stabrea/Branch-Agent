/**
 * The one address rule shared by the popup and the right-click menu: this extension talks only to
 * the paired remote address, never to this computer's own. The key the app's own page uses on your
 * computer is the whole of Branch's authority there, and an extension must not be able to borrow it.
 */

/** This computer talking to itself, which this extension will not do. */
export function isLoopback(origin) {
  let host;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return true; }
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** The Chrome permission pattern for exactly one address. */
export function hostPattern(where) {
  const url = new URL(where);
  return `${url.protocol}//${url.hostname}${url.port ? ":" + url.port : ""}/*`;
}
