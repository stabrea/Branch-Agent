import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { BranchBrowser, redirectHops } from "../dist/integrations/browser.js";
import { ToolRegistry, Budget } from "../dist/index.js";

/**
 * A redirect to a website the owner allowed is followed; one to anywhere else is still not.
 *
 * Refusing every redirect looked safe and broke the ordinary way of signing in: the form is answered
 * with "now go here", and Branch landed on a browser error page instead of the page it had just signed
 * in to. The existing test — "an allowed site cannot redirect the browser to an unlisted origin" —
 * passed either way, because it only checks that the forbidden website was never fetched. So nothing
 * went red while the guard was far stricter than it meant to be.
 *
 * Local only: two small servers on 127.0.0.1 and a headless browser.
 */

const context = (permissions = ["browser.read", "browser.interact"]) => ({
  owner: "test", workspace: ".", runId: "redirect", signal: AbortSignal.timeout(60000),
  budget: new Budget(), permissions: new Set(permissions), depth: 0,
});

/** A site that signs a member in with a redirect, the way nearly every site does. */
async function siteThatRedirects() {
  const asked = [];
  const sessions = new Set();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const signedIn = /(?:^|;\s*)sid=in\b/.test(request.headers.cookie ?? "");
    asked.push({ path: url.pathname, signedIn });
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<!doctype html><body><h1>Way in</h1><form method="GET" action="/enter"><button type="submit">Sign in</button></form>');
      return;
    }
    if (url.pathname === "/enter") {
      sessions.add("in");
      response.writeHead(302, { "set-cookie": "sid=in; Path=/", location: "/desk" });
      response.end();
      return;
    }
    if (url.pathname === "/desk") {
      response.writeHead(signedIn ? 200 : 401, { "content-type": "text/html" });
      response.end(`<!doctype html><body><h1>${signedIn ? "Signed in at the desk" : "Please sign in"}</h1>`);
      return;
    }
    if (url.pathname.startsWith("/round")) { // a site that never stops sending the browser onwards
      const at = Number(url.pathname.slice("/round".length) || "0");
      response.writeHead(302, { location: `/round${at + 1}` });
      response.end();
      return;
    }
    response.writeHead(404).end("no");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${server.address().port}`, asked,
    close: async () => { server.close(); await once(server, "close"); },
  };
}

test("signing in works: the redirect the site answers with is followed, and the session survives it", async (t) => {
  const site = await siteThatRedirects();
  t.after(() => site.close());
  const browser = new BranchBrowser({ allowedOrigins: [site.origin] });
  t.after(() => browser.close());
  const registry = new ToolRegistry();
  const { registerBrowser } = await import("../dist/integrations/browser.js");
  registerBrowser(registry, browser);

  await registry.execute("browser.navigate", { url: site.origin }, context());
  await registry.execute("browser.click", { role: "button", name: "Sign in" }, context());
  const page = await registry.execute("browser.snapshot", {}, context());

  assert.match(page.accessibility, /Signed in at the desk/, "it landed on the page it signed in to");
  assert.ok(site.asked.some((one) => one.path === "/desk" && one.signedIn),
    "and the desk was fetched with the session the redirect handed out");
});

test("a redirect to a website the owner did not allow is still refused, and never fetched", async (t) => {
  let forbiddenHits = 0;
  const forbidden = createServer((_request, response) => { forbiddenHits += 1; response.end("must not load"); });
  forbidden.listen(0, "127.0.0.1");
  await once(forbidden, "listening");
  t.after(async () => { forbidden.close(); await once(forbidden, "close"); });
  const elsewhere = `http://127.0.0.1:${forbidden.address().port}`;

  const allowed = createServer((_request, response) => { response.writeHead(302, { location: elsewhere }); response.end(); });
  allowed.listen(0, "127.0.0.1");
  await once(allowed, "listening");
  t.after(async () => { allowed.close(); await once(allowed, "close"); });
  const origin = `http://127.0.0.1:${allowed.address().port}`;

  const browser = new BranchBrowser({ allowedOrigins: [origin] });
  t.after(() => browser.close());
  await assert.rejects(browser.navigate(origin, context(["browser.read"])));
  assert.equal(forbiddenHits, 0, "the website that was not allowed was never asked for anything");
});

test("the network policy checks the redirect destination before it is fetched", async (t) => {
  let destinationHits = 0;
  const destination = createServer((_request, response) => { destinationHits += 1; response.end("must not load"); });
  destination.listen(0, "127.0.0.1");
  await once(destination, "listening");
  t.after(async () => { destination.close(); await once(destination, "close"); });
  const destinationOrigin = `http://127.0.0.1:${destination.address().port}`;

  const source = createServer((_request, response) => {
    response.writeHead(302, { location: `${destinationOrigin}/private` });
    response.end();
  });
  source.listen(0, "127.0.0.1");
  await once(source, "listening");
  t.after(async () => { source.close(); await once(source, "close"); });
  const sourceOrigin = `http://127.0.0.1:${source.address().port}`;
  const checked = [];
  const browser = new BranchBrowser({ allowedOrigins: [sourceOrigin, destinationOrigin] });
  browser.policy = { assertAllowed: async (target) => {
    checked.push(target.href);
    if (target.origin === destinationOrigin) throw new Error("blocked by the owner's network rules");
  } };
  t.after(() => browser.close());

  await assert.rejects(browser.navigate(`${sourceOrigin}/start`, context(["browser.read"])));
  assert.deepEqual(checked, [
    `${sourceOrigin}/start`, // browser.navigate checks before opening a window
    `${sourceOrigin}/start`, // Chromium's actual first request is checked too
    `${destinationOrigin}/private`, // then the redirect hop is checked before it is sent
  ]);
  assert.equal(destinationHits, 0, "the destination was refused before a request reached it");
});

test("a pop-up cannot send its first request to an unlisted website", async (t) => {
  let forbiddenHits = 0;
  const forbidden = createServer((_request, response) => { forbiddenHits += 1; response.end("must not load"); });
  forbidden.listen(0, "127.0.0.1");
  await once(forbidden, "listening");
  t.after(async () => { forbidden.close(); await once(forbidden, "close"); });
  const forbiddenOrigin = `http://127.0.0.1:${forbidden.address().port}`;

  const allowed = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<button onclick="window.open('${forbiddenOrigin}/stolen')">Open report</button>`);
  });
  allowed.listen(0, "127.0.0.1");
  await once(allowed, "listening");
  t.after(async () => { allowed.close(); await once(allowed, "close"); });
  const allowedOrigin = `http://127.0.0.1:${allowed.address().port}`;
  const browser = new BranchBrowser({ allowedOrigins: [allowedOrigin] });
  t.after(() => browser.close());
  const registry = new ToolRegistry();
  const { registerBrowser } = await import("../dist/integrations/browser.js");
  registerBrowser(registry, browser);

  await registry.execute("browser.navigate", { url: allowedOrigin }, context());
  await registry.execute("browser.click", { role: "button", name: "Open report" }, context());
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(forbiddenHits, 0, "the pop-up was refused before its first request left Chromium");
});

test("a site that keeps sending the browser onwards is given up on", async (t) => {
  const site = await siteThatRedirects();
  t.after(() => site.close());
  const browser = new BranchBrowser({ allowedOrigins: [site.origin] });
  t.after(() => browser.close());

  await assert.rejects(browser.navigate(`${site.origin}/round0`, context(["browser.read"])),
    "a round of redirects ends in a refusal rather than going on for ever");
  const rounds = site.asked.filter((one) => one.path.startsWith("/round"));
  // A fixed number on purpose: measuring against the product's own constant would move with it, and
  // then loosening the limit would still pass.
  assert.ok(rounds.length <= 8, `it stopped after a few (${rounds.length})`);
  assert.ok(redirectHops <= 5, `and the limit itself stays small (${redirectHops})`);
});
