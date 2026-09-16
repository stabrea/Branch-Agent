/**
 * Some MCP servers do not only answer with text: they answer with a small page — a form, a picker,
 * a chart — meant to be shown to the person. Branch will show one, inside a frame that can do
 * almost nothing: no scripts, no forms, no fonts or pictures from anywhere else, and no way to
 * reach the network at all. The page is served from Branch's own address with a content policy
 * that a script cannot talk its way out of, and the frame itself is sandboxed with nothing allowed.
 *
 * The effect is that an "MCP app" can lay out what it wants and the person can read it, and that
 * is the whole of what it can do. A page that tries to run a script simply does not run it.
 */
import { z } from "zod";

/**
 * The rules the browser is given. `sandbox` with nothing after it is the strictest form: the page
 * gets an origin of its own, scripts do not run, forms do not submit, and nothing pops up.
 * `default-src 'none'` then refuses every fetch, image, font and frame the page might still ask
 * for, so the only thing it can show is what came down with it.
 */
export const appContentSecurityPolicy = [
  "sandbox",
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

/** Headers every MCP app page is served with. */
export function appHeaders(): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": appContentSecurityPolicy,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    // Nothing on this page may ask for the camera, the microphone or where the computer is.
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "cache-control": "no-store",
  };
}

export const AppResourceSchema = z.object({
  /** Which connected server the page came from, for the heading above the frame. */
  server: z.string().min(1).max(80),
  uri: z.string().min(1).max(500),
  html: z.string().max(400_000),
}).strict();
export type AppResource = z.infer<typeof AppResourceSchema>;

const openTag = /<\s*(script|iframe|object|embed|form|base|meta|link)\b/gi;
const closeTag = /<\s*\/\s*(script|iframe|object|embed|form|base|meta|link)\s*>/gi;
const handler = /\son[a-z]+\s*=/gi;
const scheme = /(href|src|action)\s*=\s*(["']?)\s*(javascript|data|vbscript):/gi;

/**
 * Takes the tags out that a sandboxed frame would refuse anyway, so the page a person sees is the
 * page that was meant, not a broken half of one. The content policy is what actually stops a
 * script; this only removes the wreckage, and says how much it removed.
 */
export function sanitiseApp(html: string): { html: string; removed: number } {
  let removed = 0;
  const count = (value: string): string => { removed++; return value; };
  const cleaned = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, () => count(""))
    .replace(/<style\b([\s\S]*?)<\/style\s*>/gi, (match) => match)
    .replace(openTag, (match) => count(`&lt;${match.replace(/^<\s*/, "")}`))
    .replace(closeTag, (match) => count(`&lt;${match.replace(/^<\s*/, "")}`))
    .replace(handler, () => count(" data-blocked-handler="))
    .replace(scheme, (_match, attribute: string, quote: string) => count(`${attribute}=${quote}blocked:`));
  return { html: cleaned, removed };
}

/** The page as Branch serves it: what the server sent, wrapped so it stands on its own. */
export function appPage(resource: AppResource): { body: string; removed: number } {
  const { html, removed } = sanitiseApp(resource.html);
  const heading = escapeText(`${resource.server}: ${resource.uri}`);
  return {
    body: `<!doctype html><meta charset="utf-8"><title>${heading}</title>`
      + `<body style="font:16px system-ui;margin:0;padding:1rem">${html}</body>`,
    removed,
  };
}

const escapeText = (value: string): string =>
  value.replace(/[&<>"]/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] ?? character);
