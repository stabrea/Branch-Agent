/**
 * mac7/node-floor: the oldest Node Branch is supported on, written down once.
 *
 * Why this number. The owner's proxy setting (R17-S20, src/comfort/network.ts) works by handing
 * Node the proxy through `http.setGlobalProxyFromEnv()`, which points everything Branch sends —
 * `fetch` to the AI providers included — at that proxy. That switch arrived in Node 24.14.0, and on
 * the Node 25 line in 25.4.0. Below those, Branch has no way to tell Node about the proxy at all,
 * so a proxy someone set on a work network would quietly cover nothing. Everything else Branch
 * uses has been in Node since 24.0.0, which is why the floor moved by a patch and not by a major.
 *
 * Measured on this machine, 18 September 2026, against a real proxy that answers both a plain
 * proxied request and a CONNECT tunnel, with an https origin behind it:
 *   24.13.1  `http.setGlobalProxyFromEnv` is not a function — nothing can be pointed at a proxy
 *   24.14.0  https and http both reach the proxy and come back (as a CONNECT tunnel)
 *   24.21.0, 25.9.0, 26.4.0  the same
 *   26.5.0+  the same for https; plain http stops being tunnelled and is proxied in the ordinary
 *            way instead (undici 8.7.0, nodejs/undici#5116). Both reach the proxy.
 * An earlier reading that `fetch` ignored the proxy on Node 24 came from a test proxy that only
 * listened for ordinary requests: a CONNECT tunnel raises `connect` on a Node http server, not
 * `request`, so the tunnel was there and simply went uncounted.
 */

/** The oldest Node Branch is supported on. */
export const nodeFloor = "24.14.0";
/** The same floor on the Node 25 line: 25.0.0–25.3.x carry a higher major but not the switch. */
export const nodeFloor25 = "25.4.0";
/** `engines.node` in package.json, which must say exactly this. */
export const nodeFloorRange = ">=24.14.0 <25 || >=25.4.0";
/** The Node major the container image, the flake and the checks use; any patch of it is new enough. */
export const nodeFloorMajor = 24;

/** Compares two dotted versions: negative when `a` is older than `b`. */
function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Whether this Node is below the floor, minding the gap in the Node 25 line. */
export function nodeIsTooOld(version: string = process.versions.node): boolean {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (major === 25) return compareVersions(version, nodeFloor25) < 0;
  return compareVersions(version, nodeFloor) < 0;
}

/** What to tell a person whose Node is too old: what is needed, and what will not work until then. */
export function oldNodeNotice(version: string = process.versions.node): string {
  return [
    `This computer runs Node ${version}. Branch needs Node ${nodeFloor} or newer`,
    ` (on the Node 25 line, ${nodeFloor25} or newer). Branch will still start, but a proxy set under`,
    " Settings › Computer & browser cannot be used: this Node has no way to send Branch's own calls",
    " through it, so on a work network those calls would go out unproxied or not at all.",
    " Install a newer Node and start Branch again.",
  ].join("");
}

let alreadySaid = false;
/** Says it once per run, and only when it is true. Returns what was said, or null. */
export function sayOnceIfNodeIsTooOld(
  print: (line: string) => void,
  version: string = process.versions.node,
): string | null {
  if (alreadySaid || !nodeIsTooOld(version)) return null;
  alreadySaid = true;
  const notice = oldNodeNotice(version);
  print(notice);
  return notice;
}

/** Tests only: lets a test say it again. */
export function forgetOldNodeNotice(): void { alreadySaid = false; }
