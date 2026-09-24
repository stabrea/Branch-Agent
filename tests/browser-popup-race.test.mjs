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

test("in the owner's browser, a tab Branch's tab opens sends nothing, even before anyone knows whose it is, and theirs are untouched", async () => {
  const ourTab = fakePage("ours");
  let windowRoute, answerOpener;
  const opened = Object.assign(fakePage("opened"), {
    opener: () => new Promise((resolve) => { answerOpener = () => resolve(ourTab); }),
  });
  const theirs = Object.assign(fakePage("theirs"), { opener: async () => null });
  const context = Object.assign(events(), {
    setDefaultTimeout() {},
    route: async (_pattern, handler) => { windowRoute = handler; },
    unroute: async () => {},
    newCDPSession: async () => ({ on() {}, send: async () => {} }),
    newPage: async () => { await null; context.emit("page", ourTab); return ourTab; }, // Playwright tells of a page after the call returns
  });
  const session = new BrowserSession(async () => { throw new Error("not launched in the owner's browser"); }, async () => {});
  session.options = { attached: { context } };
  await session.use({ owner: "o", runId: "r", signal: new AbortController().signal }, async () => undefined);
  const request = (page, url) => {
    const route = { outcome: null, request: () => ({ url: () => url, resourceType: () => "document", frame: () => ({ page: () => page, parentFrame: () => null }) }),
      abort: async () => { route.outcome = "aborted"; }, fallback: async () => { route.outcome = "passed on"; }, continue: async () => { route.outcome = "continued"; } };
    return route;
  };

  // A tab Branch's page opened: its first request arrives before anyone knows whose tab it is.
  context.emit("page", opened);
  const first = request(opened, "http://unlisted.test/");
  const handled = windowRoute(first);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(first.outcome, null, "nothing is sent while the question is open");
  answerOpener();
  await handled;
  for (let i = 0; i < 20 && opened.closes === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(first.outcome, "aborted", "Branch's tab opened it, so it gets nothing");
  assert.equal(opened.closes, 1, "and it is closed");

  // The owner's own tab: passed on as it was, and never closed.
  context.emit("page", theirs);
  const mine = request(theirs, "http://anything.test/");
  await windowRoute(mine);
  assert.equal(mine.outcome, "passed on");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(theirs.closes, 0);
});

test("giving the owner's browser back closes Branch's tabs and the tabs they opened before the window's route comes off", async () => {
  const steps = [];
  const ourTab = Object.assign(fakePage("ours"), { close: async () => { steps.push("closed ours"); } });
  const opened = Object.assign(fakePage("opened"), { opener: async () => ourTab, close: async () => { steps.push("closed opened"); } });
  const theirs = Object.assign(fakePage("theirs"), { close: async () => { steps.push("closed theirs"); } });
  const context = Object.assign(events(), {
    setDefaultTimeout() {},
    route: async () => {},
    unroute: async () => { steps.push("route off"); },
    pages: () => [ourTab, opened, theirs],
    newCDPSession: async () => ({ on() {}, send: async () => {} }),
    newPage: async () => { await null; context.emit("page", ourTab); return ourTab; },
  });
  const session = new BrowserSession(async () => { throw new Error("not launched in the owner's browser"); }, async () => {});
  session.options = { attached: { context, detach: async () => { steps.push("detached"); } } };
  await session.use({ owner: "o", runId: "r", signal: new AbortController().signal }, async () => undefined);
  await session.close();
  const off = steps.indexOf("route off");
  assert.ok(off > steps.indexOf("closed ours") && off > steps.indexOf("closed opened") && steps.includes("closed ours") && steps.includes("closed opened"),
    `Branch's tabs and theirs-by-Branch are closed while the route still stands (${steps.join(", ")})`);
  assert.equal(steps.includes("closed theirs"), false, "the owner's own tab is left open");
});

test("in the owner's browser, a new tab's first request is refused when whose tab it is cannot be asked", async () => {
  let windowRoute;
  const ourTab = fakePage("ours");
  const context = Object.assign(events(), {
    setDefaultTimeout() {},
    route: async (_pattern, handler) => { windowRoute = handler; },
    unroute: async () => {},
    pages: () => [ourTab],
    browser: () => ({ newBrowserCDPSession: async () => { throw new Error("Target closed"); } }),
    newCDPSession: async () => ({ on() {}, send: async () => {} }),
    newPage: async () => { await null; context.emit("page", ourTab); return ourTab; },
  });
  const session = new BrowserSession(async () => { throw new Error("not launched in the owner's browser"); }, async () => {});
  session.options = { attached: { context } };
  await session.use({ owner: "o", runId: "r", signal: new AbortController().signal }, async () => undefined);
  const route = { outcome: null,
    request: () => ({ url: () => "http://unlisted.test/", resourceType: () => "document", isNavigationRequest: () => true,
      frame: () => { throw new Error("Frame for this navigation request is not available"); } }),
    abort: async () => { route.outcome = "aborted"; }, fallback: async () => { route.outcome = "passed on"; }, continue: async () => { route.outcome = "continued"; } };
  await windowRoute(route);
  assert.equal(route.outcome, "aborted");
});

/** The owner's window with Chrome's target list stood in for: `targets` is what Target.getTargets answers. */
async function borrowedWindow() {
  const ourTab = Object.assign(fakePage("ours"), { tid: "t0" });
  const state = { targets: [{ targetId: "t0", type: "page", url: "http://allowed.test/" }], closed: [], route: null, ourTargetFails: false };
  const browserSession = { send: async (method, params) => {
    if (method === "Target.getTargets") return { targetInfos: state.targets.map((target) => ({ ...target })) };
    if (method === "Target.closeTarget") { state.closed.push(params.targetId); state.targets = state.targets.filter((target) => target.targetId !== params.targetId); }
    return {};
  }, detach: async () => {} };
  const context = Object.assign(events(), {
    setDefaultTimeout() {},
    route: async (_pattern, handler) => { state.route = handler; },
    unroute: async () => {},
    pages: () => [ourTab],
    browser: () => ({ newBrowserCDPSession: async () => browserSession }),
    newCDPSession: async (page) => {
      if (page === ourTab && state.ourTargetFails) throw new Error("Target closed");
      return { on() {}, detach: async () => {}, send: async () => ({ targetInfo: { targetId: page.tid } }) };
    },
    newPage: async () => { await null; context.emit("page", ourTab); return ourTab; },
  });
  const session = new BrowserSession(async () => { throw new Error("not launched in the owner's browser"); }, async () => {});
  session.options = { attached: { context } };
  await session.use({ owner: "o", runId: "r", signal: new AbortController().signal }, async () => undefined);
  const request = (page) => {
    const route = { outcome: null,
      request: () => ({ url: () => "http://unlisted.test/", resourceType: () => "document", isNavigationRequest: () => true,
        frame: () => (page ? { page: () => page, parentFrame: () => null } : (() => { throw new Error("Frame for this navigation request is not available"); })()) }),
      abort: async () => { route.outcome = "aborted"; }, fallback: async () => { route.outcome = "passed on"; }, continue: async () => { route.outcome = "continued"; } };
    return route;
  };
  return { state, context, ourTab, send: async (page) => { const route = request(page); await state.route(route); return route.outcome; } };
}

test("in the owner's browser, a tab opened by a tab Branch's tab opened is refused even once that one is closed", async () => {
  const { state, send } = await borrowedWindow();
  state.targets.push({ targetId: "p", type: "page", url: "", openerId: "t0" });
  assert.equal(await send(), "aborted");
  assert.deepEqual(state.closed, ["p"]);
  // p has gone from Chrome's list, but the tab it opened still names it as its opener.
  state.targets.push({ targetId: "g", type: "page", url: "", openerId: "p" });
  assert.equal(await send(), "aborted", "the grandchild sends nothing");
  assert.deepEqual(state.closed, ["p", "g"]);
});

test("in the owner's browser, a tab at the end of a long chain of tabs from Branch's tab is refused", async () => {
  const { state, send } = await borrowedWindow();
  for (let hop = 1; hop <= 12; hop++)
    state.targets.push({ targetId: `c${hop}`, type: "page", url: hop === 12 ? "" : "http://x.test/", openerId: hop === 1 ? "t0" : `c${hop - 1}` });
  assert.equal(await send(), "aborted");
  assert.ok(state.closed.includes("c12"));
});

test("in the owner's browser, a new tab is refused when which tabs are Branch's cannot be read", async () => {
  const { state, send } = await borrowedWindow();
  state.ourTargetFails = true;
  state.targets.push({ targetId: "p", type: "page", url: "", openerId: "t0" });
  assert.equal(await send(), "aborted");
});

test("in the owner's browser, a page whose traced opener has closed is refused and closed; the owner's own is not", async () => {
  const { state, context, send } = await borrowedWindow();
  state.targets.push({ targetId: "p", type: "page", url: "", openerId: "t0" });
  assert.equal(await send(), "aborted"); // p is traced, then closed
  const orphan = Object.assign(fakePage("orphan"), { tid: "g", opener: async () => null });
  const theirs = Object.assign(fakePage("theirs"), { tid: "o1", opener: async () => null });
  state.targets.push({ targetId: "g", type: "page", url: "http://x.test/", openerId: "p" }, { targetId: "o1", type: "page", url: "http://mine.test/" });
  context.emit("page", orphan);
  context.emit("page", theirs);
  assert.equal(await send(orphan), "aborted");
  assert.equal(await send(theirs), "passed on");
  for (let i = 0; i < 20 && orphan.closes === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(orphan.closes, 1);
  assert.equal(theirs.closes, 0);
});
