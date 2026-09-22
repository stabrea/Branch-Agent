import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { inflateSync } from "node:zlib";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { BranchBrowser, registerBrowser } from "../dist/integrations/browser.js";
import { ToolRegistry, Budget, createBranch } from "../dist/index.js";

/**
 * execution.browser: a job that spans more than one page, on one signed-in session, with a picture of
 * the page that is really a picture.
 *
 * The browser tests so far fill one form on one page and never take a screenshot, so two things the row
 * asks for were never shown: that the site still knows who Branch is on the *second* page, and that
 * `browser.screenshot` produces an image rather than a promise of one.
 *
 * The site here signs a member in, gives the session a cookie, and refuses both inner pages without it.
 * It records the session behind every request, so the test can say plainly that one session — not two,
 * and not none — carried the whole way. The picture is then opened: every chunk's check number, the
 * header's own width and height, and the compressed image data uncompressed to exactly the size that
 * header describes.
 *
 * Everything is local: one HTTP server on 127.0.0.1 and a headless browser. No window is opened.
 */

const MEMBER = "4471", ORDER = "8812";

/** A small site with a way in, two pages behind it, and a memory of who asked for what. */
async function memberSite() {
  const sessions = new Map();
  const asked = [];
  let next = 1;
  const sessionOf = (request) => {
    const cookie = /(?:^|;\s*)sid=([^;]+)/.exec(request.headers.cookie ?? "");
    return cookie && sessions.has(cookie[1]) ? cookie[1] : null;
  };
  const page = (response, body) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><meta charset="utf-8"><title>Members</title><body>${body}</body>`);
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const sid = sessionOf(request);
    asked.push({ path: url.pathname, sid });
    if (url.pathname === "/") {
      page(response, `<h1>Members</h1><form method="GET" action="/enter">
        <label>Member number <input name="member" /></label>
        <button type="submit">Sign in</button></form>`);
      return;
    }
    if (url.pathname === "/enter") {
      // The way in answers with the desk page itself rather than sending the browser on to it: Branch's
      // browser aborts every redirect today, which is its own defect and not this row's business.
      const member = url.searchParams.get("member") ?? "";
      const id = `s${next++}`;
      sessions.set(id, member);
      response.writeHead(200, { "set-cookie": `sid=${id}; Path=/; HttpOnly`, "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><meta charset="utf-8"><title>Members</title><body>
        <h1>Welcome, member ${member}</h1><p>You are signed in.</p><a href="/desk">Go to the desk</a></body>`);
      return;
    }
    if (!sid) { // both inner pages are closed without the session
      response.writeHead(401, { "content-type": "text/html" });
      response.end("<!doctype html><body><h1>Please sign in</h1>");
      return;
    }
    if (url.pathname === "/desk") {
      page(response, `<h1>The desk of member ${sessions.get(sid)}</h1>
        <p>You are signed in.</p><a href="/orders">Open orders</a>`);
      return;
    }
    if (url.pathname === "/orders") {
      page(response, `<h1>Orders</h1><p id="order">Order ${ORDER} for member ${sessions.get(sid)}</p>
        <a href="/desk">Back to the desk</a>`);
      return;
    }
    response.writeHead(404).end("no");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    asked,
    sessionsMade: () => next - 1,
    close: async () => { server.close(); await once(server, "close"); },
  };
}

/* ---------- opening a PNG far enough to know it is one ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/**
 * The header, every part's check number, and the image data uncompressed to exactly the size the
 * header describes. That is as far as a picture can be opened without writing a whole PNG reader, and
 * it is far enough that an empty file, a truncated one or a file of anything else cannot pass.
 */
function openPng(file) {
  const bytes = Buffer.from(file);
  assert.ok(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "it begins the way a PNG begins");
  let at = 8, header = null, ended = false;
  const pressed = [];
  while (at + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(at), type = bytes.subarray(at + 4, at + 8).toString("ascii");
    assert.ok(at + 12 + size <= bytes.length, `the ${type} part fits inside the file`);
    const data = bytes.subarray(at + 8, at + 8 + size);
    assert.equal(bytes.readUInt32BE(at + 8 + size), crc32(bytes.subarray(at + 4, at + 8 + size)),
      `the ${type} part's check number is right`);
    if (type === "IHDR") header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4),
      depth: data[8], colour: data[9], interlace: data[12] };
    if (type === "IDAT") pressed.push(data);
    if (type === "IEND") ended = true;
    at += 12 + size;
  }
  assert.ok(header, "it says how big it is");
  assert.ok(ended, "and it says where it ends");
  assert.equal(header.interlace, 0);
  const channels = CHANNELS[header.colour];
  assert.ok(channels, `a colour kind a reader understands (${header.colour})`);
  const flat = inflateSync(Buffer.concat(pressed));
  const stride = 1 + Math.ceil((header.width * channels * header.depth) / 8);
  assert.equal(flat.length, stride * header.height,
    "the image data uncompresses to exactly one row per line of the picture");
  return header;
}

/* ---------- the test ---------- */

async function branchAndBrowser(t, origin) {
  const root = await mkdtemp(join(tmpdir(), "branch-browser-session-"));
  const closing = [];
  t.after(async () => { for (const close of closing.reverse()) await close(); await discardTemp(root); });
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  closing.push(() => app.close());
  const browser = new BranchBrowser({ allowedOrigins: [origin] });
  browser.artifacts = app.artifacts;
  closing.push(() => browser.close());
  const registry = new ToolRegistry();
  registerBrowser(registry, browser);
  return { app, registry, root };
}

test("one signed-in session carries across two pages, and the picture of the page is a real picture", async (t) => {
  const site = await memberSite();
  t.after(() => site.close());
  const { registry, app } = await branchAndBrowser(t, site.origin);
  const context = {
    owner: "local", workspace: ".", runId: "browsersession", signal: AbortSignal.timeout(60000),
    budget: new Budget(), permissions: new Set(["browser.read", "browser.interact"]), depth: 0,
  };

  // Closed before signing in: the site itself says so.
  await registry.execute("browser.navigate", { url: `${site.origin}/desk` }, context);
  assert.match((await registry.execute("browser.snapshot", {}, context)).accessibility, /Please sign in/);

  // Sign in, then walk to a second page by following the site's own link.
  await registry.execute("browser.navigate", { url: site.origin }, context);
  await registry.execute("browser.fill", { label: "Member number", value: MEMBER }, context);
  await registry.execute("browser.click", { role: "button", name: "Sign in" }, context);
  assert.match((await registry.execute("browser.snapshot", {}, context)).accessibility,
    new RegExp(`Welcome, member ${MEMBER}`), "signing in worked");

  await registry.execute("browser.click", { role: "link", name: "Go to the desk" }, context);
  assert.match((await registry.execute("browser.snapshot", {}, context)).accessibility,
    new RegExp(`The desk of member ${MEMBER}`), "the first page behind the door knows who signed in");

  await registry.execute("browser.click", { role: "link", name: "Open orders" }, context);
  const second = await registry.execute("browser.snapshot", {}, context);
  assert.match(second.accessibility, new RegExp(`Order ${ORDER} for member ${MEMBER}`),
    "and the second page still knows, so the session was carried and not rebuilt");

  // The site's own record: one session made, and both inner pages asked for under that same one.
  assert.equal(site.sessionsMade(), 1, "signing in happened once");
  const inner = site.asked.filter((one) => ["/desk", "/orders"].includes(one.path) && one.sid);
  assert.ok(inner.length >= 2, "both pages were fetched with a session");
  assert.equal(new Set(inner.map((one) => one.sid)).size, 1, "and it was the same session for both");
  assert.ok(site.asked.some((one) => one.path === "/desk" && !one.sid), "the first try really had none");

  // A picture of the page, opened.
  const shot = await registry.execute("browser.screenshot", {}, context);
  assert.equal(shot.mediaType, "image/png");
  assert.match(shot.url, /\/orders$/, "the picture is of the page it was standing on");
  const bytes = await readFile(shot.path);
  assert.ok(bytes.length > 1000, `a real file, not a token (${bytes.length} bytes)`);
  assert.equal(bytes.length, shot.bytes, "and what was kept is the size it says");
  const picture = openPng(bytes);
  assert.ok(picture.width > 100 && picture.height > 100, `a page-sized picture (${picture.width}x${picture.height})`);

  // It was kept where the app keeps things, so the conversation can get at it.
  const listed = await app.artifacts.list();
  assert.ok(listed.some((entry) => entry.path === shot.path && entry.mediaType === "image/png"),
    "the picture is listed among what this task made");
});

test("the picture is of the page as it is now, not of the page before", async (t) => {
  const site = await memberSite();
  t.after(() => site.close());
  const { registry } = await branchAndBrowser(t, site.origin);
  const context = {
    owner: "local", workspace: ".", runId: "browsershots", signal: AbortSignal.timeout(60000),
    budget: new Budget(), permissions: new Set(["browser.read", "browser.interact"]), depth: 0,
  };

  await registry.execute("browser.navigate", { url: site.origin }, context);
  await registry.execute("browser.fill", { label: "Member number", value: MEMBER }, context);
  await registry.execute("browser.click", { role: "button", name: "Sign in" }, context);
  await registry.execute("browser.click", { role: "link", name: "Go to the desk" }, context);
  const desk = await registry.execute("browser.screenshot", {}, context);
  await registry.execute("browser.click", { role: "link", name: "Open orders" }, context);
  const orders = await registry.execute("browser.screenshot", {}, context);

  assert.match(desk.url, /\/desk$/);
  assert.match(orders.url, /\/orders$/);
  assert.notEqual(desk.path, orders.path, "two pictures, not one kept twice");
  const first = await readFile(desk.path), second = await readFile(orders.path);
  openPng(first); openPng(second);
  assert.ok(!first.equals(second), "and the two pages do not look the same");
});
