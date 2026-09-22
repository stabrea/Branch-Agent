import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { BranchBrowser, registerBrowser } from "../dist/integrations/browser.js";
import { savePolicy } from "../dist/policy.js";

/**
 * packages.browser: a form that runs across several pages is filled in to the end, and the one step
 * that would actually do something — placing the order — stops and asks first.
 *
 * The browser tests so far press one button on one page, and the approval tests use a stand-in tool,
 * so "it fills a form in and waits before the part that matters" was never shown together. Here the
 * shop and the checkout are two different hosts, as they usually are in real life, and the owner's
 * rules allow the shop and ask about the checkout. That is what "the configured approval" means.
 *
 * Local only: two small servers and a headless browser. No window opens.
 */

const step = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });
const calls = (...toolCalls) => () => ({ content: "", toolCalls });
const say = (content) => () => ({ content, toolCalls: [] });

/** The shop, on 127.0.0.1: a form across three pages, and nothing on it does anything by itself. */
async function shopSite() {
  const said = { name: "", street: "" };
  const page = (body) => `<!doctype html><meta charset="utf-8"><body>${body}</body>`;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.searchParams.get("name")) said.name = url.searchParams.get("name");
    if (url.searchParams.get("street")) said.street = url.searchParams.get("street");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (url.pathname === "/step2")
      response.end(page(`<h1>Where to</h1><form method="GET" action="/step3">
        <label>Street <input name="street" /></label><button type="submit">Next</button></form>`));
    else if (url.pathname === "/step3")
      response.end(page(`<h1>Ready</h1><p>For ${said.name || "nobody"}, at ${said.street || "nowhere"}.</p>`));
    else
      response.end(page(`<h1>Who for</h1><form method="GET" action="/step2">
        <label>Your name <input name="name" /></label><button type="submit">Next</button></form>`));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${server.address().port}`, said,
    close: async () => { server.close(); await once(server, "close"); },
  };
}

/** The checkout, on localhost: a different host, and the only place an order can really be placed. */
async function checkoutSite() {
  const orders = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/placed") orders.push(new Date().toISOString());
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(url.pathname === "/placed"
      ? "<!doctype html><body><h1>Order placed</h1>"
      : `<!doctype html><body><h1>Confirm</h1><form method="GET" action="/placed">
         <button type="submit">Place the order</button></form>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://localhost:${server.address().port}`, orders,
    close: async () => { server.close(); await once(server, "close"); },
  };
}

function scripted(steps) {
  const provider = {
    name: "scripted", requests: [],
    async complete(request) {
      provider.requests.push(request);
      return steps[Math.min(provider.requests.length - 1, steps.length - 1)](request);
    },
    reset() { provider.requests.length = 0; },
  };
  return provider;
}

async function shopping(t, makeSteps) {
  const shop = await shopSite(), checkout = await checkoutSite();
  t.after(() => shop.close());
  t.after(() => checkout.close());
  const root = await mkdtemp(join(tmpdir(), "branch-form-approval-"));
  const closing = [];
  t.after(async () => { for (const close of closing.reverse()) await close(); await discardTemp(root); });
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted(makeSteps(shop, checkout)),
  });
  closing.push(() => app.close());
  // This drives a real browser through BranchBrowser, so the file says which engine it needs and the
  // test selector provisions it. Proof that the browser really runs is the rest of the test: every
  // step below goes through the installed headless shell.
  assert.equal(chromium.name(), "chromium", "this test declares the browser engine it requires");
  const browser = new BranchBrowser({ allowedOrigins: [shop.origin, checkout.origin] });
  browser.artifacts = app.artifacts;
  closing.push(() => browser.close());
  registerBrowser(app.registry, browser);
  // The owner's rules: the shop is fine, the checkout is asked about, everything else is fine.
  savePolicy(app.store, app.runtime.owner, {
    rules: [
      { tool: "browser.*", match: "127.0.0.1:*", decision: "allow" },
      // Looking at the checkout is fine; pressing the button that places the order is not.
      { tool: "browser.navigate", match: "localhost:*", decision: "allow" },
      { tool: "browser.click", match: "localhost:*", decision: "ask", remember: "session" },
      { tool: "*", match: "*", decision: "allow" },
    ],
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  closing.push(() => server.close());
  const api = async (method, path, body) => {
    const answer = await fetch(server.url + path, {
      method,
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: answer.status, body: await answer.json().catch(() => ({})) };
  };
  return { app, api, shop, checkout };
}

/** Filling the form in, all the way to the button that would really do something. */
const theWholeForm = (shop, checkout) => [
  calls(step("c1", "browser.navigate", { url: `${shop.origin}/step1` })),
  calls(step("c2", "browser.fill", { label: "Your name", value: "Sam Okafor" })),
  calls(step("c3", "browser.click", { role: "button", name: "Next" })),
  calls(step("c4", "browser.fill", { label: "Street", value: "12 Oak Lane" })),
  calls(step("c5", "browser.click", { role: "button", name: "Next" })),
  calls(step("c6", "browser.navigate", { url: `${checkout.origin}/confirm` })),
  calls(step("c7", "browser.click", { role: "button", name: "Place the order" })),
  say("Everything is filled in and waiting for you."),
];

test("the form is filled in across its pages, and the order stops to ask before it is placed", async (t) => {
  const { app, api, shop, checkout } = await shopping(t, theWholeForm);

  const run = (await api("POST", "/api/run", { prompt: "Order the oak table for me, but check with me first." })).body;
  const events = app.store.events(run.id);
  const kinds = events.map((event) => event.kind);

  // The pages before the checkout went through without a word.
  const ran = events.filter((event) => event.kind === "tool.completed").map((event) => event.data.name);
  assert.ok(ran.includes("browser.fill"), `the form was filled in (${[...new Set(ran)].join(", ") || "nothing ran"})`);
  assert.equal(shop.said.name, "Sam Okafor", "the shop really received the name");
  assert.equal(shop.said.street, "12 Oak Lane", "and the street from the second page");

  // The step that would really do something stopped and asked.
  assert.ok(kinds.includes("policy.ask"), `it asked before placing the order (${[...new Set(kinds)].join(", ")})`);
  const asked = events.find((event) => event.kind === "policy.ask").data;
  assert.equal(asked.name, "browser.click");
  assert.match(String(asked.target), /localhost/, "the question names the checkout, not the shop");

  // And nothing was ordered.
  assert.deepEqual(checkout.orders, [], "no order was placed while the question was unanswered");
});

test("the rules are what decide: the shop is allowed, the checkout is asked about", async (t) => {
  const { app, shop, checkout } = await shopping(t, () => [say("nothing to do")]);
  const { evaluatePolicy, readPolicy } = await import("../dist/policy.js");
  const policy = readPolicy(app.store, app.runtime.owner);
  // The target a browser tool reports is the host **with its port**, which is what the rule must match.
  const decide = (origin) => evaluatePolicy(policy, { tool: "browser.click", target: new URL(origin).host, readOnly: false }).decision;

  assert.equal(decide(shop.origin), "allow", "the shop's pages are the owner's own business");
  assert.equal(decide(checkout.origin), "ask", "the checkout is asked about");
  assert.notEqual(new URL(shop.origin).hostname, new URL(checkout.origin).hostname,
    "the two are different hosts, which is what the rule turns on");
});
