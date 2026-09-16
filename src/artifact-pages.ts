import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { appHeaders, sanitiseApp } from "./mcp-apps.js";

/**
 * An artifact is a small page the assistant wrote inside its own reply: a fenced `html` or `svg`
 * block. Branch shows it rather than leaving the owner to read the markup, and it shows it in the
 * same frame an MCP app gets — served from this app's own address under a content policy that gives
 * the page an origin of its own, runs no script, submits no form and fetches nothing at all.
 *
 * The frame therefore cannot reach the page around it, the session key, or the network. Where a
 * reply carries a `javascript` or `python` block instead, the page is not the thing that runs it:
 * the owner presses a button in the app, and that goes through `code.run` and the switch that
 * guards it, like any other tool.
 *
 * The app's own colours are passed in as CSS variables so an artifact sits in the page rather than
 * fighting it. They are values read off the running page, and every one is checked against a short
 * pattern before it is written into the style block.
 */

/** A token value the page may pass in: colours, lengths and font names, and nothing else. */
const cssValue = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9 ,.()#%/_+-]+$/,
  "A colour or size only");
const cssName = z.string().trim().regex(/^--[a-z0-9-]{1,40}$/, "A token name looks like --paper");

/** How much of an artifact Branch will show. Beyond this the reply is simply too big to be one. */
export const maxArtifactChars = 200_000;

export const ArtifactPageSchema = z.object({
  /** `html` is a small page; `svg` is one drawing. Both are shown, neither is run. */
  kind: z.enum(["html", "svg"]),
  title: z.string().trim().max(120).default("Artifact"),
  code: z.string().min(1).max(maxArtifactChars),
  tokens: z.record(cssName, cssValue).default({}),
}).strict();
export type ArtifactPage = z.infer<typeof ArtifactPageSchema>;
/** How long a minted address keeps working. Long enough to read one and open it larger. */
export const artifactPageLifetimeMs = 600_000;
const heldPages = new Map<string, { page: ArtifactPage; until: number }>();

const escapeText = (value: string): string =>
  value.replace(/[&<>"]/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] ?? character);

/** The app's colours, as the artifact's own `:root`, so it matches the theme around it. */
function tokenStyle(tokens: Record<string, string>): string {
  const lines = Object.entries(tokens).slice(0, 40).map(([name, value]) => `${name}:${value}`);
  return `:root{${lines.join(";")}}`
    + "html,body{margin:0;background:var(--paper,#fff);color:var(--ink,#111)}"
    + "body{font:15px/1.5 system-ui,sans-serif;padding:12px}"
    + "img,svg,table{max-width:100%}";
}

/** The artifact as Branch serves it: the owner's colours, then what the assistant wrote. */
export function artifactPageBody(page: ArtifactPage): { body: string; removed: number } {
  const { html, removed } = sanitiseApp(page.code);
  const title = escapeText(page.title || "Artifact");
  return {
    body: `<!doctype html><meta charset="utf-8"><title>${title}</title>`
      + `<style>${tokenStyle(page.tokens)}</style><body>${html}</body>`,
    removed,
  };
}

/**
 * Keeps an artifact under an unguessable name for ten minutes. Unlike an MCP app's address this one
 * is NOT used up by the first fetch: a frame reloads, "open larger" opens a second copy of the same
 * artifact, and a screenshot takes the page twice, all of which would otherwise be a dead link.
 */
export function holdArtifactPage(page: ArtifactPage): string {
  for (const [id, held] of heldPages) if (held.until < Date.now()) heldPages.delete(id);
  while (heldPages.size > 40) heldPages.delete(heldPages.keys().next().value!);
  const id = randomBytes(24).toString("base64url");
  heldPages.set(id, { page, until: Date.now() + artifactPageLifetimeMs });
  return id;
}

/** `GET /artifact/<name>`: the artifact itself, for the frame. Returns false for any other path. */
export function artifactPageRoute(request: IncomingMessage, response: ServerResponse, path: string): boolean {
  const match = /^\/artifact\/([A-Za-z0-9_-]{32,48})$/.exec(path);
  if (!match || request.method !== "GET") return false;
  const held = heldPages.get(match[1]!);
  if (!held || held.until < Date.now()) {
    heldPages.delete(match[1]!);
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "That artifact has expired. Open the reply again." }));
    return true;
  }
  const page = artifactPageBody(held.page);
  response.writeHead(200, { ...appHeaders(), "x-artifact-removed": String(page.removed) });
  response.end(page.body);
  return true;
}

/** What the browser sends to keep an artifact beside the task it came from. */
export const ArtifactSaveSchema = z.object({
  runId: z.string().uuid(),
  name: z.string().trim().min(1).max(60).regex(/^[a-z0-9][a-z0-9._-]*$/i, "Letters, digits, dots, dashes and underscores"),
  mediaType: z.enum(["text/html", "image/svg+xml", "text/plain", "application/json"]),
  code: z.string().min(1).max(maxArtifactChars),
}).strict();
