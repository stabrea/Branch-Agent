/* A website's pop-up that appears while the assistant is opening a tab of its own is still a pop-up: its
   first request is refused and it is closed. Counting every page that appeared meanwhile as the assistant's
   let such a pop-up through, unguarded (NAS b7f2560). Node only: Playwright's objects are stood in for,
   so the pop-up can be made to arrive at exactly that moment. */
import test from "node:test";
import assert from "node:assert/strict";
import { BrowserSession } from "../dist/integrations/browser-session.js";

function events() {
  const handlers = new Map();
  return {
    on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    emit(name, ...args) { for (const fn of handlers.get(name) ?? []) fn(...args); },
  };
}
function fakePage(name) {
  const page = Object.assign(events(), {
    name, closes: 0,
    close: async () => { page.closes += 1; },
    isClosed: () => page.closes > 0,
    opener: async () => null,
    url: () => "about:blank",
    route: async () => {}, unroute: async () => {}, addInitScript: async () => {},
  });
  return page;
}
function fakeRoute(page, url = "http://allowed.test/") {
  const route = {
    outcome: null,
    request: () => ({ url: () => url, resourceType: () => "document", frame: () => ({ page: () => page, parentFrame: () => null }) }),
    abort: async () => { route.outcome = "aborted"; },
    continue: async () => { route.outcome = "continued"; },
  };
  return route;
}

test("a pop-up that opens while the assistant is opening a tab is refused and closed; the assistant's tab is kept", async () => {
  const first = fakePage("first"), ours = fakePage("ours"), popup = fakePage("popup");
  let routeHandler, finishTab;
  const context = Object.assign(events(), {
    setDefaultTimeout() {}, routeWebSocket: async () => {}, addInitScript: async () => {}, close: async () => {},
    route: async (_pattern, handler) => { routeHandler = handler; },
    newCDPSession: async () => ({ on() {}, send: async () => {} }),
    newPage: (() => {
      let made = 0;
      return () => {
        made += 1;
        if (made === 1) { context.emit("page", first); return Promise.resolve(first); }
        return new Promise((resolve) => { finishTab = () => { context.emit("page", ours); resolve(ours); }; });
      };
    })(),
  });
  const session = new BrowserSession(async () => ({ newContext: async () => context }), async () => {});
  const signal = new AbortController().signal;
  await session.use({ owner: "o", runId: "r", signal }, async () => undefined);

  const opening = session.openTab();
  await new Promise((resolve) => setImmediate(resolve));
  // The website's pop-up arrives now, while the assistant's own tab is still being made.
  context.emit("page", popup);
  const popupRequest = fakeRoute(popup, "http://allowed.test/popup");
  const answered = routeHandler(popupRequest);
  finishTab();
  await opening;
  await answered;
  for (let i = 0; i < 20 && popup.closes === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(popupRequest.outcome, "aborted", "the pop-up's first request was refused");
  assert.equal(popup.closes, 1, "and the pop-up was closed");
  assert.equal(ours.closes, 0, "the assistant's own tab was kept");
  const ourRequest = fakeRoute(ours);
  await routeHandler(ourRequest);
  assert.equal(ourRequest.outcome, "continued", "and what it asks for goes through");
  assert.equal(session.tabs().length, 2);
});

test("in the owner's browser, a tab Branch's tab opens sends nothing while it is still being asked whose it is", async () => {
  const ourTab = fakePage("ours");
  let tabRoute, answerOpener;
  const opened = Object.assign(fakePage("opened"), {
    route: async (_pattern, handler) => { tabRoute = handler; },
    unroute: async () => {},
    opener: () => new Promise((resolve) => { answerOpener = () => resolve(ourTab); }),
  });
  const context = Object.assign(events(), {
    setDefaultTimeout() {},
    newCDPSession: async () => ({ on() {}, send: async () => {} }),
    newPage: async () => { await null; context.emit("page", ourTab); return ourTab; }, // Playwright tells of a page after the call returns
  });
  const session = new BrowserSession(async () => { throw new Error("not launched in the owner's browser"); }, async () => {});
  session.options = { attached: { context } };
  await session.use({ owner: "o", runId: "r", signal: new AbortController().signal }, async () => undefined);

  context.emit("page", opened);
  for (let i = 0; i < 20 && !tabRoute; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  // Its first request arrives before anyone knows whose tab it is.
  const first = { outcome: null, abort: async () => { first.outcome = "aborted"; }, fallback: async () => { first.outcome = "sent"; } };
  const handled = tabRoute(first);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(first.outcome, null, "nothing is sent while the question is open");
  answerOpener();
  await handled;
  for (let i = 0; i < 20 && opened.closes === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(first.outcome, "aborted", "Branch's tab opened it, so it gets nothing");
  assert.equal(opened.closes, 1, "and it is closed");
});
