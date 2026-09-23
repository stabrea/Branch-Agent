import type { IncomingMessage, ServerResponse } from "node:http";
import { OfficeCoedit, coeditMediaTypes, type CoeditKind } from "./document-coedit.js";

/**
 * The web side of FQ-workspace.office's co-edit sessions (src/document-coedit.ts): the owner's own
 * JSON routes under `/api/office-coedit`, checked the same way as every other `/api/*` route, and
 * the plain page at `/coedit/:id` the other person opens with the link and code the owner hands
 * them — no account, no bearer key, so it is answered before the owner's own key is ever checked,
 * exactly like `/share/:id` (src/conversation-share.ts) already is.
 */
export const handlesOfficeCoeditPath = (path: string): boolean =>
  path === "/api/office-coedit" || path.startsWith("/api/office-coedit/");

export class OfficeCoeditHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const refuse = (message: string): never => { throw new OfficeCoeditHttpError(400, message); };

export interface OfficeCoeditDeps { coedit: OfficeCoedit; owner: string; method: string; readBody: () => Promise<unknown> }

/** The owner's own routes: list, start, look at one, send a change, end it. */
export async function officeCoeditApi(deps: OfficeCoeditDeps, path: string): Promise<unknown> {
  const { coedit, owner, method } = deps;
  if (path === "/api/office-coedit") {
    if (method === "GET") return { sessions: coedit.list(owner) };
    if (method === "POST") return coedit.start(owner, await deps.readBody());
    return refuse("Unsupported method");
  }
  const one = /^\/api\/office-coedit\/([a-f0-9-]{36})$/.exec(path);
  if (one) {
    if (method === "GET") return coedit.get(owner, one[1]!);
    if (method === "DELETE") return coedit.end(owner, one[1]!);
    return refuse("Unsupported method");
  }
  const edit = /^\/api\/office-coedit\/([a-f0-9-]{36})\/edit$/.exec(path);
  if (edit && method === "POST") return coedit.ownerEdit(owner, edit[1]!, await deps.readBody());
  throw new OfficeCoeditHttpError(404, "Endpoint not found");
}

/** The owner's own download of the current bytes: an authenticated binary route, like an artifact's file. */
export async function officeCoeditFileRoute(
  coedit: OfficeCoedit, owner: string, request: IncomingMessage, response: ServerResponse, path: string,
): Promise<boolean> {
  const match = /^\/api\/office-coedit\/([a-f0-9-]{36})\/file$/.exec(path);
  if (!match || request.method !== "GET") return false;
  const found = coedit.download(owner, match[1]!);
  sendFile(response, found);
  return true;
}
function sendFile(response: ServerResponse, found: { bytes: Buffer; name: string; kind: CoeditKind }): void {
  response.writeHead(200, {
    "content-type": coeditMediaTypes[found.kind], "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-disposition": `attachment; filename="${found.name.replace(/["\r\n]/g, "")}"`,
  });
  response.end(found.bytes);
}

const notAvailablePage = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Not available</title></head>`
  + `<body style="font:16px system-ui;margin:3rem auto;max-width:32rem"><h1>This shared edit is not available</h1>`
  + `<p>Ask whoever sent it to share it again.</p></body></html>`;
const guestCsp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const escape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pageStyle = `body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:#03140b;color:#edf1ea}
main{max-width:40rem;margin:0 auto;padding:2.5rem 1.25rem 4rem}
h1{font-size:1.4rem;margin:0 0 .25rem}.meta{color:rgba(237,241,234,.6);font-size:.85rem;margin:0 0 1.5rem}
pre{white-space:pre-wrap;word-break:break-word;background:rgba(5,24,15,.94);border:1px solid rgba(236,241,233,.12);
  border-radius:10px;padding:1rem;max-height:20rem;overflow:auto}
form{margin:1.25rem 0;padding:1rem;border:1px solid rgba(236,241,233,.12);border-radius:10px}
label{display:block;margin:.5rem 0 .25rem;font-size:.85rem}
input[type=text]{width:100%;box-sizing:border-box;padding:.5rem;border-radius:6px;border:1px solid rgba(236,241,233,.25);
  background:rgba(5,24,15,.6);color:inherit}
button{margin-top:.75rem;padding:.5rem 1rem;border-radius:6px;border:0;background:#2f7a4f;color:#fff;font-weight:600}
.notice{border:1px solid rgba(242,197,114,.4);background:rgba(242,197,114,.13);border-radius:10px;padding:.75rem 1rem;margin:0 0 1rem;font-size:.9rem}
.log{font-size:.85rem;color:rgba(237,241,234,.75)}`;

function readUrlEncoded(request: IncomingMessage, maxBytes = 65536): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let bytes = 0; const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { request.destroy(); reject(new Error("Form too large")); return; }
      chunks.push(chunk);
    });
    request.on("end", () => { try { resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error as Error); } });
    request.on("error", reject);
  });
}
const codeEntryPage = (id: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />`
  + `<meta name="robots" content="noindex, nofollow" /><title>Enter the code</title><style>${pageStyle}</style></head>`
  + `<body><main><h1>Edit this document together</h1><p class="meta">Enter the six-character code you were given.</p>`
  + `<form method="GET" action="/coedit/${id}"><label for="code">Code</label>`
  + `<input type="text" id="code" name="code" maxlength="6" required autocapitalize="characters" />`
  + `<button type="submit">Open</button></form></main></body></html>\n`;

function guestMainPage(id: string, code: string, view: { name: string; kind: string; version: number; preview: string;
  log: { participant: string; changes: number; notes: string[]; at: string }[] }): string {
  const codeField = `<input type="hidden" name="code" value="${escape(code)}" />`;
  const log = view.log.slice(-8).reverse().map((entry) =>
    `<p class="log">${escape(entry.participant === "owner" ? "The owner" : "You")} · ${entry.changes ? `${entry.changes} change${entry.changes === 1 ? "" : "s"}` : "no match"}`
    + (entry.notes.length ? ` — ${escape(entry.notes.join(" "))}` : "") + `</p>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />`
    + `<meta name="robots" content="noindex, nofollow" /><title>${escape(view.name)}</title><style>${pageStyle}</style></head>`
    + `<body><main><h1>${escape(view.name)}</h1>`
    + `<p class="meta">${view.kind.toUpperCase()} · version ${view.version} · you and the owner are both editing this file</p>`
    + `<pre>${escape(view.preview) || "(empty)"}</pre>`
    + `<form method="POST" action="/coedit/${id}/edit">${codeField}`
    + `<label for="find">Find</label><input type="text" id="find" name="find" maxlength="2000" required />`
    + `<label for="replaceWith">Replace with</label><input type="text" id="replaceWith" name="replaceWith" maxlength="4000" />`
    + `<button type="submit">Send this change</button></form>`
    + `<p><a style="color:#9fd9b8" href="/coedit/${id}/file?code=${encodeURIComponent(code)}">Download the current file</a></p>`
    + (log ? `<h2 style="font-size:.9rem;color:rgba(237,241,234,.7)">Recent changes</h2>${log}` : "")
    + `</main></body></html>\n`;
}

/**
 * `/coedit/:id`: the other person's whole door. GET with no code asks for one; GET with the right
 * code shows the document and a form to send one change; POST to `/edit` sends it and comes back to
 * the same page; GET `/file` hands back the bytes. A wrong or missing code, an unknown id, and a
 * closed session all answer with the one same page, so guessing at an address gives nothing away.
 */
export async function officeCoeditGuestPage(
  coedit: OfficeCoedit, request: IncomingMessage, response: ServerResponse, path: string,
): Promise<boolean> {
  const page = /^\/coedit\/([a-f0-9-]{36})$/.exec(path);
  const edit = /^\/coedit\/([a-f0-9-]{36})\/edit$/.exec(path);
  const file = /^\/coedit\/([a-f0-9-]{36})\/file$/.exec(path);
  if (!page && !edit && !file) return false;
  const send = (status: number, body: string): void => {
    response.writeHead(status, {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": guestCsp,
    });
    response.end(body);
  };
  if (page && request.method === "GET") {
    const id = page[1]!;
    const code = new URL(request.url ?? "/", "http://local").searchParams.get("code") ?? "";
    if (!code) { send(200, codeEntryPage(id)); return true; }
    try { send(200, guestMainPage(id, code, coedit.guestView(id, code))); }
    catch { send(403, notAvailablePage); }
    return true;
  }
  if (edit && request.method === "POST") {
    const id = edit[1]!;
    const form = await readUrlEncoded(request).catch(() => new URLSearchParams());
    const code = form.get("code") ?? "";
    try {
      coedit.guestEdit(id, code, { find: form.get("find") ?? "", replaceWith: form.get("replaceWith") ?? "", all: true });
      response.writeHead(303, { location: `/coedit/${id}?code=${encodeURIComponent(code)}` });
      response.end();
    } catch { send(403, notAvailablePage); }
    return true;
  }
  if (file && request.method === "GET") {
    const id = file[1]!;
    const code = new URL(request.url ?? "/", "http://local").searchParams.get("code") ?? "";
    try { sendFile(response, coedit.guestDownload(id, code)); }
    catch { send(403, notAvailablePage); }
    return true;
  }
  return false;
}
