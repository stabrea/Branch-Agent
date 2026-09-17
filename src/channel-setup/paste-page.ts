import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Recipe } from "./recipes.js";

/**
 * A page on this computer, used once, for pasting a token when the terminal cannot hide what is
 * typed. It listens only on 127.0.0.1, at an address with a long random part, takes one form from
 * its own page and closes. The address carries no token; what is pasted travels in the form body.
 */
const escape = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function pageHtml(recipe: Recipe, nonce: string): string {
  const inputs = recipe.paste.map((paste) =>
    `<p><label>${escape(paste.what)}${paste.optional ? " (optional)" : ""}<br><input type="password" name="${paste.secret}" autocomplete="off" spellcheck="false"></label></p>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<title>Paste for ${escape(recipe.name)}</title></head><body><h1>Paste for ${escape(recipe.name)}</h1>` +
    `<p>This page is on your own computer and works once. What you paste goes to Branch's locker and is not shown again.</p>` +
    `<form method="post"><input type="hidden" name="nonce" value="${nonce}">${inputs}<p><button>Send to Branch</button></p></form></body></html>`;
}

function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; if (body.length > 16_000) { reject(new Error("too long")); request.destroy(); } });
    request.on("end", () => resolve(new URLSearchParams(body)));
    request.on("error", reject);
  });
}
const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function refuse(response: ServerResponse, status: number): void { response.writeHead(status, { "content-type": "text/plain" }).end("Not here."); }

export async function openPastePage(recipe: Recipe, timeoutMs = 15 * 60_000): Promise<{ url: string; values: Promise<Record<string, string>> }> {
  const path = `/paste/${randomBytes(24).toString("hex")}`, nonce = randomBytes(24).toString("hex");
  let settle!: (values: Record<string, string>) => void, fail!: (error: Error) => void;
  const values = new Promise<Record<string, string>>((resolve, reject) => { settle = resolve; fail = reject; });
  let origin = "";
  const server = createServer((request, response) => {
    const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; form-action 'self'" };
    if (request.url !== path) return refuse(response, 404);
    if (request.method === "GET") return void response.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" }).end(pageHtml(recipe, nonce));
    if (request.method !== "POST" || (request.headers.origin && request.headers.origin !== origin)) return refuse(response, 403);
    readForm(request).then((form) => {
      if (!same(form.get("nonce") ?? "", nonce)) return refuse(response, 403);
      const pasted: Record<string, string> = {};
      for (const paste of recipe.paste) { const value = form.get(paste.secret)?.trim(); if (value) pasted[paste.secret] = value; }
      response.writeHead(200, { ...headers, "content-type": "text/plain; charset=utf-8" }).end("Received. You can close this page and go back to the terminal.");
      close();
      settle(pasted);
    }, () => refuse(response, 400));
  });
  const timer = setTimeout(() => { close(); fail(new Error("The paste page closed after waiting too long.")); }, timeoutMs);
  timer.unref();
  function close(): void { clearTimeout(timer); server.close(); server.closeAllConnections(); }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return { url: origin + path, values };
}
