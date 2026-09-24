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
  // browser.navigate checks before opening a window; Chromium's actual first request is then checked by both the
  // route and the pause (the route's check once missed pages entirely, comparing 'document' with 'Document');
  // then the redirect hop is checked before it is sent, and last.
  assert.equal(checked.filter((href) => href === `${sourceOrigin}/start`).length, 3, checked.join(" "));
  assert.deepEqual(checked.filter((href) => href !== `${sourceOrigin}/start`), [`${destinationOrigin}/private`]);
  assert.equal(checked.at(-1), `${destinationOrigin}/private`);
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


test("being sent to a website costs the task the same as going there by name", async (t) => {
  // How many different websites one task may visit was charged only where an address is typed.
  // Going straight to a second website was refused; being *sent* there by a redirect was not, so a
  // chain of them could walk a task across every website the owner allowed for the price of one.
  let secondHits = 0;
  const second = createServer((_request, response) => {
    secondHits += 1;
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><body><h1>The second place</h1>");
  });
  second.listen(0, "127.0.0.1");
  await once(second, "listening");
  t.after(async () => { second.close(); await once(second, "close"); });
  const elsewhere = `http://127.0.0.1:${second.address().port}`;

  const first = createServer((request, response) => {
    if ((request.url ?? "/") === "/away") { response.writeHead(302, { location: elsewhere }); response.end(); return; }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><body><h1>The first place</h1>");
  });
  first.listen(0, "127.0.0.1");
  await once(first, "listening");
  t.after(async () => { first.close(); await once(first, "close"); });
  const origin = `http://127.0.0.1:${first.address().port}`;

  // Both websites are allowed. What is limited is how many of them one task may visit.
  const browser = new BranchBrowser({ allowedOrigins: [origin, elsewhere], maxOriginsPerRun: 1 });
  t.after(() => browser.close());

  await browser.navigate(origin, context(["browser.read"]));
  await assert.rejects(browser.navigate(elsewhere, context(["browser.read"])),
    /already opened 1 different websites/, "going there by name is refused, as it always was");

  // The same website, reached by being sent to it. It has to cost the same.
  await browser.navigate(`${origin}/away`, context(["browser.read"])).catch(() => undefined);
  assert.equal(secondHits, 0, "the second website was never asked for anything");
});


test("a pop-up cannot be redirected to an unlisted website either", async (t) => {
  // The existing test above proves a pop-up's *first* request is checked. What it could not see is
  // what happens when that first request is to a website the owner allowed and the answer is "now go
  // here": the hops after it are Chromium's own, and the pause that watches those is attached only
  // to tabs Branch opened. Measured before the fix, the unlisted website really served the page.
  //
  // Attaching the pause to the pop-up as well does not close it: the first request and its redirect
  // are in flight before the pause can be enabled. A tab the website opened by itself is going to be
  // closed anyway, so until it is, it is answered with nothing at all.
  let forbiddenHits = 0;
  const forbidden = createServer((_request, response) => {
    forbiddenHits += 1;
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><body><h1>must not load</h1>");
  });
  forbidden.listen(0, "127.0.0.1");
  await once(forbidden, "listening");
  t.after(async () => { forbidden.close(); await once(forbidden, "close"); });
  const elsewhere = `http://127.0.0.1:${forbidden.address().port}`;

  const allowed = createServer((request, response) => {
    if ((request.url ?? "/") === "/hop") { response.writeHead(302, { location: `${elsewhere}/taken` }); response.end(); return; }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><body><a id="go" href="/hop" target="_blank">open</a>`
      + `<script>document.getElementById("go").click()</script>`);
  });
  allowed.listen(0, "127.0.0.1");
  await once(allowed, "listening");
  t.after(async () => { allowed.close(); await once(allowed, "close"); });
  const origin = `http://127.0.0.1:${allowed.address().port}`;

  const browser = new BranchBrowser({ allowedOrigins: [origin] });
  t.after(() => browser.close());
  await browser.navigate(origin, context(["browser.read"]));
  // The pop-up opens, asks, and is closed. Long enough that a request in flight would have landed.
  await new Promise((resolve) => { setTimeout(resolve, 2500); });

  assert.equal(forbiddenHits, 0, "the website that was not allowed was never asked for anything");
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

/**
 * A frame an allowed page shows cannot be sent to a website the owner did not allow, whether its own request or
 * its own navigation is redirected. In Branch's own window such a frame shares the page's process (measured), so
 * this holds by the pause; the owner's Chrome, where it does not, is asked the same in tests/browser-2.test.mjs.
 */
test("a frame from another allowed website cannot be redirected to an unlisted one", async (t) => {
  let forbiddenHits = 0;
  const forbidden = createServer((_request, response) => { forbiddenHits += 1; response.end("must not load"); });
  forbidden.listen(0, "127.0.0.1");
  await once(forbidden, "listening");
  t.after(async () => { forbidden.close(); await once(forbidden, "close"); });
  const forbiddenOrigin = `http://127.0.0.1:${forbidden.address().port}`;

  const framedAsked = [];
  const framed = createServer((request, response) => {
    framedAsked.push(request.url);
    if (request.url === "/f") {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><script>fetch("/r").catch(() => {}); setTimeout(() => { location = "/r2"; }, 300);</script>`);
      return;
    }
    response.writeHead(302, { location: `${forbiddenOrigin}/stolen` });
    response.end();
  });
  framed.listen(0, "127.0.0.1");
  await once(framed, "listening");
  t.after(async () => { framed.close(); await once(framed, "close"); });
  // Another website: a different host name is a different site, so Chromium puts its frame in its own process.
  const framedOrigin = `http://localhost:${framed.address().port}`;

  const page = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><h1>Report</h1><iframe src="${framedOrigin}/f"></iframe>`);
  });
  page.listen(0, "127.0.0.1");
  await once(page, "listening");
  t.after(async () => { page.close(); await once(page, "close"); });
  const pageOrigin = `http://127.0.0.1:${page.address().port}`;

  const browser = new BranchBrowser({ allowedOrigins: [pageOrigin, framedOrigin] });
  t.after(() => browser.close());
  const registry = new ToolRegistry();
  const { registerBrowser } = await import("../dist/integrations/browser.js");
  registerBrowser(registry, browser);
  await registry.execute("browser.navigate", { url: pageOrigin }, context());
  for (let waited = 0; waited < 40 && !(framedAsked.includes("/r") && framedAsked.includes("/r2")); waited++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(framedAsked.includes("/r") && framedAsked.includes("/r2"), `the frame really asked: ${framedAsked.join(" ")}`);
  assert.equal(forbiddenHits, 0, "neither the frame's fetch nor its own navigation was sent onwards");
});
