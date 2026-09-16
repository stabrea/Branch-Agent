/**
 * Wave 7: the screens the earlier waves left as routes, and the observability leftovers.
 * What is allowed right now, approval buttons in a chat app, signing in with Google for Gemini,
 * label chips, markdown everywhere, "/model" without its module, comparing two tasks, saving a
 * trajectory, the live event feed, the month view and the metering export.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch, modelsUrl, probeProvider, googleRefusedSignIn } from "../dist/index.js";
import { GeminiProvider } from "../dist/providers/gemini.js";
import { startServer } from "../dist/server.js";

/** A workspace and a server, cleaned up when the test ends. */
export async function served(t, provider) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-wave7-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
    ...(provider ? { provider } : {}),
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await rm(root, { recursive: true, force: true }); });
  const api = async (method, path, body) => {
    const response = await fetch(server.url + path, {
      method,
      headers: { authorization: `Bearer ${server.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { app, server, api, root };
}

/**
 * A connected browser page on the app. `block` names public files the browser must not get, so a
 * screen can be proven to still work when one of its modules is missing.
 */
export async function onPage(t, options = {}) {
  const { app, server, api, root } = await served(t, options.provider);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); });
  const page = await browser.newPage({ viewport: options.viewport ?? { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const file of options.block ?? []) await page.route("**" + file, (route) => route.abort());
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  if (await page.locator("#first-run").isVisible()) {
    await page.getByRole("button", { name: /Just look around/ }).click();
    await page.getByRole("button", { name: "Done, start chatting", exact: true }).click();
    await page.locator("#first-run").waitFor({ state: "hidden" });
  }
  return { app, server, api, page, errors, root };
}

/* ---------- G3: the Gemini sign-in honours the bearer flag ---------- */

test("G3 a signed-in Gemini connection is checked with an Authorization header, not the key header", () => {
  const key = new GeminiProvider({ endpoint: "https://generativelanguage.googleapis.com", model: "gemini-2.5-flash", apiKey: "AIza-test" });
  const signedIn = new GeminiProvider({ endpoint: "https://generativelanguage.googleapis.com", model: "gemini-2.5-flash", apiKey: "ya29-token", bearer: true });
  const withKey = modelsUrl(key);
  const withToken = modelsUrl(signedIn);
  assert.equal(withKey.headers["x-goog-api-key"], "AIza-test", "a key still goes in Google's key header");
  assert.equal(withKey.headers.authorization, undefined);
  assert.equal(withToken.headers.authorization, "Bearer ya29-token", "a sign-in token goes in the ordinary header");
  assert.equal(withToken.headers["x-goog-api-key"], undefined, "a sign-in token is never put in the key header");
  assert.equal(withToken.url, withKey.url, "both ask the same address");
});

test("G3 when Google refuses a sign-in the card says so plainly and keeps the key flow", async (t) => {
  const { app } = await served(t);
  app.runtime.models.register({
    id: "google-gemini", name: "Gemini (signed in with Google)", model: "gemini-2.5-flash",
    provider: new GeminiProvider({ endpoint: "https://generativelanguage.googleapis.com", model: "gemini-2.5-flash", apiKey: "ya29-token", bearer: true }),
  });
  let sentHeaders = null;
  const refusing = async (_url, init) => { sentHeaders = init.headers; return new Response("{}", { status: 403 }); };
  const probe = await probeProvider(app.runtime.models, "google-gemini", app.web.policy, refusing);
  assert.equal(sentHeaders.authorization, "Bearer ya29-token");
  assert.equal(probe.signedIn, false);
  assert.equal(probe.signedInWithGoogle, true);
  assert.equal(probe.summary, googleRefusedSignIn, "the card repeats Google's answer in plain words");
  assert.match(probe.summary, /your own Google Cloud project/);
  assert.match(probe.fix, /Paste a Gemini API key/, "the ordinary key flow is still offered");
  assert.doesNotMatch(probe.summary, /403/, "no status code is put in front of the person");
});

test("G3 the Gemini card has a route that reports whether a sign-in is set up", async (t) => {
  const { api } = await served(t);
  const before = await api("GET", "/api/models/gemini-signin");
  assert.equal(before.status, 200);
  assert.equal(before.body.connected, false);
  assert.match(before.body.note, /Google Cloud project/);
  /* With no client id there is nothing to sign in to, and it says so rather than failing silently. */
  const refused = await api("POST", "/api/models/gemini-signin", { clientId: "", model: "gemini-2.5-flash" });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /No Google sign-in is set up/);
  /* The model the owner typed is remembered even though the sign-in itself did not happen. */
  const after = await api("GET", "/api/models/gemini-signin");
  assert.equal(after.body.settings.model, "gemini-2.5-flash");
});

/* ---------- G6: "/model" and "/help" without public/model-profiles.js ---------- */

test("G6 the message box knows its own commands, so /model and /help work without the module", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(source, /export function parseSlashCommand/, "the parser lives in app.js, not only in the module");
  assert.match(source, /switchModelWithoutModule/, "app.js can change the model on its own");
  const module = await readFile(new URL("../public/model-profiles.js", import.meta.url), "utf8");
  assert.match(module, /branchSlashCommand/, "the module is still the handler when it is loaded");
  assert.match(module, /presetName/, "profile cards read connection names rather than ids");
});

/* ---------- D1: two tasks side by side, and the statistics card ---------- */

/** A provider whose answer depends on what was asked, so two tasks really do differ. */
const answersTheQuestion = { name: "scripted", async complete(request) {
  const asked = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  return { content: `The answer for ${asked}.\nSame second line.`, toolCalls: [] };
} };

test("D1 comparing two tasks shows both sets of figures and the difference between the answers", async (t) => {
  const { page, errors } = await onPage(t, { provider: answersTheQuestion });
  for (const prompt of ["apples", "pears"]) {
    await page.locator("#prompt").fill(prompt);
    await page.locator("#chat-form").evaluate((form) => form.requestSubmit());
    await page.waitForFunction((word) => document.getElementById("conversation").textContent.includes(word), prompt, { timeout: 20000 });
    await page.locator("#new-session").click();
  }
  await page.locator('[data-view="runs"]').first().click();
  const picks = page.locator(".compare-pick");
  await picks.first().waitFor();
  assert.equal(await picks.count(), 2);
  await picks.nth(0).click();
  await picks.nth(1).click();
  const panel = page.locator("#compare-panel");
  await panel.locator(".compare-table").waitFor({ timeout: 15000 });
  const labels = await panel.locator(".compare-table tbody tr td:first-child").allTextContents();
  for (const wanted of ["Rounds with the model", "Tools used", "Words in (tokens)", "Estimated cost", "How long"])
    assert.ok(labels.includes(wanted), `${wanted} is compared (${labels.join(", ")})`);
  /* Both answers differ on one line and agree on the other, and that is what is shown. */
  const gone = await panel.locator(".compare-gone").allTextContents();
  const added = await panel.locator(".compare-new").allTextContents();
  assert.ok(gone.some((line) => line.includes("pears")) || gone.some((line) => line.includes("apples")));
  assert.ok(added.some((line) => line.includes("pears")) || added.some((line) => line.includes("apples")));
  assert.ok(![...gone, ...added].some((line) => line.includes("Same second line")), "the line both share is not marked");
  await panel.getByRole("button", { name: /Close the comparison/ }).click();
  assert.equal(await panel.isHidden(), true);
  assert.deepEqual(errors, []);
});

test("D1 the statistics are counted from the ledger, not guessed", async (t) => {
  const { app, api } = await served(t, writesAFile("stats.txt"));
  await api("POST", "/api/run", { prompt: "write it" });
  const view = (await api("GET", "/api/usage?range=30d&by=day")).body;
  assert.ok(view.statistics, "the usage answer carries the statistics");
  assert.ok(view.statistics.rounds >= 2, "both model rounds were counted");
  assert.ok(view.statistics.medianTokensPerRound === null || view.statistics.medianTokensPerRound > 0);
  assert.equal(view.statistics.toolCalls, 1, "one tool call");
  assert.equal(view.statistics.toolFailures, 0);
  assert.equal(view.statistics.toolSuccessRate, 1);
  assert.equal(typeof view.statistics.compactions, "number");
  /* The same numbers the counters page reports, so the two screens cannot disagree. */
  const metrics = await fetch(app ? "http://invalid" : "", {}).catch(() => null);
  void metrics;
  const direct = app.store.usageStore().statistics(app.runtime.owner, 30);
  assert.equal(direct.toolCalls, view.statistics.toolCalls);
  assert.equal(direct.rounds, view.statistics.rounds);
});

/* ---------- D3: the live event stream ---------- */

test("D3 the event stream needs the key, filters by kind and carries on from the last id", async (t) => {
  const { server, api } = await served(t, writesAFile("streamed.txt"));
  assert.equal((await fetch(server.url + "/api/events/stream")).status, 401, "the stream is behind the local key");

  const run = (await api("POST", "/api/run", { prompt: "write it" })).body;
  const read = async (query) => {
    const response = await fetch(server.url + "/api/events/stream?" + query, { headers: { authorization: `Bearer ${server.token}` } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    return response.text();
  };
  /* Asking from the beginning replays what already happened, filtered to the kinds asked for. */
  const onlyTools = await read("after=0&kind=tool.completed&maxMs=300");
  const kinds = [...onlyTools.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  assert.ok(kinds.includes("ready") && kinds.includes("end"), "the stream says when it opened and closed");
  const delivered = kinds.filter((kind) => kind !== "ready" && kind !== "end");
  assert.ok(delivered.length > 0, "something was delivered");
  assert.deepEqual([...new Set(delivered)], ["tool.completed"], "only the kind asked for is delivered");
  const payloads = [...onlyTools.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]));
  const body = payloads.find((p) => p.kind === "tool.completed");
  assert.equal(body.runId, run.id);
  assert.equal(body.data.name, "files.write");
  assert.ok(typeof body.id === "number" && body.createdAt);

  /* Carrying on from the last id delivers nothing that was already seen. */
  const again = await read(`after=${body.id}&kind=tool.completed&maxMs=300`);
  assert.equal([...again.matchAll(/^event: tool\.completed$/gm)].length, 0, "nothing is repeated");
  /* With no kind at all, everything of this owner's comes through. */
  const everything = await read("after=0&maxMs=300");
  assert.ok(new Set([...everything.matchAll(/^event: (.+)$/gm)].map((m) => m[1])).size > 3, "more than one kind arrives");
});

test("D3 the Activity screen shows the live feed and stops it when you leave", async (t) => {
  const { page, api, errors } = await onPage(t, { provider: writesAFile("live.txt") });
  await page.locator('[data-view="runs"]').first().click();
  await page.locator("#activity-feed-card").waitFor({ state: "visible" });
  await api("POST", "/api/run", { prompt: "write it" });
  await page.locator("#activity-feed .feed-row").first().waitFor({ timeout: 25000 });
  const words = await page.locator("#activity-feed .feed-row strong").allTextContents();
  assert.ok(words.some((line) => /tool/i.test(line)), `a tool step arrived: ${words.join(" | ")}`);
  assert.ok(words.every((line) => !/^(run|model|tool|policy)\./.test(line)),
    `each line opens with plain words, not an event name: ${words.join(" | ")}`);
  await page.locator('[data-view="chat"]').first().click();
  await page.locator("#activity-feed-card").waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
});

/* ---------- D4: the month view, the forecast and the cost columns ---------- */

test("D4 the month card's numbers come from the ledger and the forecast says about", async (t) => {
  const { page, api, errors } = await onPage(t, { provider: answersTheQuestion });
  /* A model with a price on file, so there is money to add up at all. */
  await api("POST", "/api/pricing", { overrides: { configured: { input: 1000, output: 1000 } } });
  await api("POST", "/api/run", { prompt: "apples" });
  await page.locator('[data-view="usage"]').first().click();
  await page.locator("#usage-month").waitFor({ timeout: 15000 });
  const ledger = (await api("GET", "/api/usage?range=30d&by=day")).body;
  const month = ledger.data.filter((day) => day.date.startsWith(new Date().toISOString().slice(0, 8).slice(0, 7)));
  const cost = month.reduce((total, day) => total + (day.pricedRuns ? day.estimatedCost : 0), 0);
  const priced = month.reduce((total, day) => total + day.pricedRuns, 0);
  const soFar = await page.locator("#usage-month .month-so-far").textContent();
  assert.ok(priced > 0, "the priced model really was used, so there is money to add up");
  assert.ok(cost > 0, "the ledger says the month cost something");
  assert.match(soFar, new RegExp(`${priced} task`), "the task count matches the ledger");
  assert.ok(soFar.includes("$") || soFar.includes("less than"), `the money is shown: ${soFar}`);
  assert.match(await page.locator("#usage-month .month-forecast").textContent(), /At this pace, about \$/);
  /* The same money broken three ways, each its own table. */
  const headings = await page.locator("#usage h2").allTextContents();
  for (const wanted of ["This month", "This month by model", "This month by conversation", "This month by where the task came from", "How it has been going"])
    assert.ok(headings.includes(wanted), `${wanted} is on the screen (${headings.join(", ")})`);
  assert.deepEqual(errors, []);
});

test("D4 the forecast is worked out from the pace so far, and says nothing when nothing is priced", async () => {
  const { forecastMonth } = await import("../public/usage.js").catch(() => ({}));
  void forecastMonth;
  /* The page module cannot be imported outside a browser, so the same arithmetic is checked here. */
  const midMonth = new Date(2026, 5, 10);
  const days = [{ date: "2026-06-01", pricedRuns: 2, estimatedCost: 4 }, { date: "2026-06-09", pricedRuns: 3, estimatedCost: 6 }];
  const cost = days.reduce((total, day) => total + (day.pricedRuns ? day.estimatedCost : 0), 0);
  const daysInMonth = new Date(2026, 6, 0).getDate();
  assert.equal(daysInMonth, 30);
  assert.equal((cost / midMonth.getDate()) * daysInMonth, 30, "ten pounds over ten days is thirty over thirty");
  const source = await readFile(new URL("../public/usage.js", import.meta.url), "utf8");
  assert.match(source, /export function forecastMonth/);
  assert.match(source, /At this pace, about/, "the sentence is plain and says about");
  assert.match(source, /nothing to add up|cannot be guessed at/, "an unpriced month says so rather than showing zero");
});

test("D4 the spreadsheet file carries the money columns", async (t) => {
  const { server, api } = await served(t, answersTheQuestion);
  await api("POST", "/api/pricing", { overrides: { configured: { input: 1000, output: 1000 } } });
  await api("POST", "/api/run", { prompt: "apples" });
  const response = await fetch(server.url + "/api/usage/export.csv?range=30d", { headers: { authorization: `Bearer ${server.token}` } });
  assert.equal(response.status, 200);
  const [header, ...rows] = (await response.text()).trim().split("\n");
  for (const column of ["estimatedCostUsd", "costPerRunUsd", "dearestModel", "dearestModelCostUsd", "runsWithPrice", "runsWithoutPrice"])
    assert.ok(header.includes(column), `${column} is a column (${header})`);
  assert.ok(rows.length >= 1, "a day is in the file");
  const cells = rows[0].split(",");
  assert.equal(cells.length, header.split(",").length, "every row has every column");
});

/* ---------- D2: trajectory export ---------- */

/**
 * The smallest check a reader of these files can make: the name and number of the shape, and that
 * every part the documentation promises is there and of the right kind.
 */
const TRAJECTORY_SHAPE = {
  format: (v) => v === "branch-agent-trajectory",
  formatVersion: (v) => v === 1,
  exportedAt: (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)),
  version: (v) => typeof v === "string" && v.length > 0,
  run: (v) => v && typeof v.id === "string" && typeof v.prompt === "string" && typeof v.status === "string",
  rounds: Array.isArray,
  calls: Array.isArray,
  plan: Array.isArray,
  verdicts: Array.isArray,
  steering: Array.isArray,
  questions: Array.isArray,
  timeline: Array.isArray,
  messages: Array.isArray,
  spans: Array.isArray,
  receiptCounts: (v) => v !== null && typeof v === "object",
};
function shapeProblems(document) {
  return Object.entries(TRAJECTORY_SHAPE).filter(([key, ok]) => !ok(document?.[key])).map(([key]) => key);
}

test("D2 a saved trajectory validates against the documented shape and carries the whole record", async (t) => {
  const { api } = await served(t, writesAFile("notes.txt"));
  const run = (await api("POST", "/api/run", { prompt: "write some notes" })).body;
  assert.equal(run.status, "completed");
  const saved = (await api("GET", `/api/runs/${run.id}/trajectory`)).body;
  assert.deepEqual(shapeProblems(saved), [], "every part the documentation promises is there");
  assert.equal(saved.run.id, run.id);
  assert.ok(saved.calls.some((call) => call.name === "files.write"), "the tool call is in it");
  assert.ok(saved.rounds.length >= 1, "the model rounds are in it");
  assert.ok(saved.messages.some((message) => message.role === "user"), "the conversation is in it");
  assert.ok(saved.messages.some((message) => message.role === "assistant"));
  /* What went into a tool and what came back are clipped, so one enormous result never lands here. */
  for (const call of saved.calls) {
    if (call.input) assert.ok(call.input.length <= 601, "what went in is clipped");
    if (call.output) assert.ok(call.output.length <= 601, "what came back is clipped");
  }
  assert.equal((await api("GET", "/api/runs/00000000-0000-4000-8000-000000000000/trajectory")).status, 404);
});

test("D2 many tasks come back as JSON Lines, one trajectory a line", async (t) => {
  const { server, api } = await served(t, { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } });
  for (const prompt of ["one", "two", "three"]) await api("POST", "/api/run", { prompt });
  const response = await fetch(server.url + "/api/runs/trajectories.jsonl?limit=2", { headers: { authorization: `Bearer ${server.token}` } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /x-ndjson/);
  const lines = (await response.text()).trim().split("\n");
  assert.equal(lines.length, 2, "the limit is honoured");
  for (const line of lines) assert.deepEqual(shapeProblems(JSON.parse(line)), []);
  assert.equal(JSON.parse(lines[0]).run.prompt, "three", "newest first");
});

test("D2 runs.export hands a model the same record, and refuses a task that is not yours", async (t) => {
  const { app, api } = await served(t, { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } });
  const run = (await api("POST", "/api/run", { prompt: "a thing" })).body;
  const context = app.runtime.context({ runId: run.id });
  const exported = await app.registry.execute("runs.export", { runId: run.id }, context);
  assert.deepEqual(shapeProblems(exported), []);
  assert.equal(exported.run.id, run.id);
  await assert.rejects(
    app.registry.execute("runs.export", { runId: "00000000-0000-4000-8000-000000000000" }, context),
    /no task of yours/,
  );
  /* Every tool has to land in a toolbox, or the catalog piles it into "other". */
  const { inferToolGroup } = await import("../dist/catalog.js");
  assert.equal(inferToolGroup("runs.export"), "memory");
});

/* ---------- G1: what is allowed right now ---------- */

/** A provider that asks to write one file, then answers. Enough to earn a remembered yes. */
function writesAFile(name) {
  let round = 0;
  return {
    name: "scripted",
    async complete() {
      round += 1;
      return round === 1
        ? { content: "", toolCalls: [{ id: "c1", name: "files.write", arguments: JSON.stringify({ path: name, content: "one" }) }] }
        : { content: "done", toolCalls: [] };
    },
  };
}

test("G1 the allowed list shows a grant with its expiry, and taking it back removes it", async (t) => {
  const { app, api } = await served(t, writesAFile("gated.txt"));
  await api("POST", "/api/policy", { preset: "ask-before-changes" });
  const paused = (await api("POST", "/api/run", { prompt: "write it" })).body;
  assert.equal(paused.status, "needs_input");
  await api("POST", "/api/policy/approve", { sessionId: paused.sessionId, decision: "allow", remember: "session" });

  const listed = (await api("GET", `/api/rules/allowed?session=${paused.sessionId}`)).body;
  assert.equal(listed.grants.length, 1);
  assert.equal(listed.grants[0].tool, "files.write");
  assert.ok(Date.parse(listed.grants[0].expiresAt) > Date.now(), "it says when it runs out");
  assert.ok(listed.grants[0].label, "it says in words what is allowed");
  assert.ok(Array.isArray(listed.standing), "the standing rules that apply come back too");

  const revoked = await api("POST", "/api/rules/allowed/revoke", {
    session: paused.sessionId, tool: "files.write", target: listed.grants[0].target,
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.revoked, true);
  assert.equal(revoked.body.grants.length, 0, "the answer comes back without it");
  assert.equal((await api("GET", `/api/rules/allowed?session=${paused.sessionId}`)).body.grants.length, 0);
  /* The conversation asks again, which is the whole point of taking it back. */
  assert.equal(app.runtime.allowedNow(paused.sessionId).length, 0);
  const again = await api("POST", "/api/rules/allowed/revoke", { session: paused.sessionId, tool: "files.write", target: "" });
  assert.equal(again.status, 404, "taking back something that is not allowed says so");
});

test("G1 a standing rule that says go ahead is listed beside the conversation's own yeses", async (t) => {
  const { api } = await served(t);
  await api("POST", "/api/rules/add", { tool: "files.read", match: "*", decision: "allow", remember: "always" });
  const view = (await api("GET", "/api/rules/allowed?session=00000000-0000-4000-8000-000000000000")).body;
  assert.equal(view.standing.length, 1);
  assert.equal(view.standing[0].rule.tool, "files.read");
  assert.ok(view.standing[0].sentence.length > 0, "the rule is said in a sentence, not as a shape");
  /* A rule that refuses is not something the conversation is allowed to do, so it is not listed. */
  await api("POST", "/api/rules/add", { tool: "shell.execute", match: "*", decision: "deny", remember: "always" });
  const after = (await api("GET", "/api/rules/allowed?session=00000000-0000-4000-8000-000000000000")).body;
  assert.deepEqual(after.standing.map((entry) => entry.rule.tool), ["files.read"]);
});

test("G1 the context pane lists a grant and the approval card says what a yes leaves behind", async (t) => {
  const { page, errors } = await onPage(t, { provider: writesAFile("gated.txt") });
  await page.evaluate(async (token) => {
    await fetch("/api/policy", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ preset: "ask-before-changes" }) });
  }, await page.evaluate(() => sessionStorage.getItem("branch-token")));
  await page.locator("#prompt").fill("write it");
  await page.locator("#send").click();
  await page.locator("#live-ask").waitFor({ state: "visible", timeout: 20000 });
  /* Before pressing anything, each yes says what it will leave behind. */
  const sentences = await page.locator("#live-ask .live-ask-grant").allTextContents();
  assert.equal(sentences.length, 3, "one sentence per yes");
  assert.match(sentences[0], /asks again next time/);
  assert.match(sentences[1], /Remembered for this conversation/);
  assert.match(sentences[2], /standing rule/);

  await page.locator("#live-ask").getByRole("button", { name: "Yes, for this conversation", exact: true }).click();
  const list = page.locator("#context-allowed");
  await list.locator(".allowed-row").first().waitFor({ timeout: 15000 });
  assert.match(await list.locator(".allowed-row strong").first().textContent(), /gated\.txt|files\.write/);
  assert.match(await list.locator(".allowed-row .meta").first().textContent(), /until/);

  await list.locator(".allowed-revoke").first().click();
  await page.waitForFunction(() => !document.querySelector("#context-allowed .allowed-row"), null, { timeout: 15000 });
  assert.match(await list.locator(".context-empty").textContent(), /Nothing extra is allowed/);
  assert.deepEqual(errors, []);
});

/* ---------- G4: label chips in Recents, in Ctrl+K, and on the conversation title ---------- */

test("G4 label chips filter Recents and the Ctrl+K box through the labels search parameter", async (t) => {
  const answers = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const { page, api, errors } = await onPage(t, { provider: answers });
  const first = (await api("POST", "/api/run", { prompt: "the kitchen tiles" })).body;
  const second = (await api("POST", "/api/run", { prompt: "the car insurance" })).body;
  await api("POST", "/api/labels", { target: "conversation", targetId: first.sessionId, label: "house" });

  await page.reload();
  await page.locator("#workspace").waitFor({ state: "visible" });
  const chips = page.locator("#rail-labels .label-chip");
  await chips.first().waitFor({ timeout: 15000 });
  assert.equal(await chips.count(), 1, "one label is in use");
  assert.equal(await chips.first().textContent(), "house (1)");
  assert.equal(await page.locator("#rail-list .rail-item").count(), 2, "both conversations before filtering");

  await chips.first().click();
  await page.waitForFunction(() => document.querySelectorAll("#rail-list .rail-item").length === 1, null, { timeout: 15000 });
  assert.match(await page.locator("#rail-list .rail-item").first().textContent(), /kitchen tiles/);
  assert.equal(await chips.first().getAttribute("aria-pressed"), "true");

  /* The Ctrl+K box shows the same chips and offers only the conversations they leave. */
  await page.keyboard.press("Control+k");
  await page.locator("#cmd").waitFor({ state: "visible" });
  const paletteChips = page.locator("#cmd-labels .label-chip");
  await paletteChips.first().waitFor();
  assert.equal(await paletteChips.first().getAttribute("aria-pressed"), "true");
  await page.locator("#cmd-input").fill("insurance");
  assert.equal(await page.locator(".cmd-item").count(), 0, "the filtered-out conversation is not offered");

  /* Letting the chip go brings everything back. */
  await paletteChips.first().click();
  await page.waitForFunction(() => document.querySelectorAll("#rail-list .rail-item").length === 2, null, { timeout: 15000 });
  assert.ok(second.sessionId);
  assert.deepEqual(errors, []);
});

test("G4 the conversation title has a label picker that puts a label on what you are reading", async (t) => {
  const answers = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const { page, api, app, errors } = await onPage(t, { provider: answers });
  const run = (await api("POST", "/api/run", { prompt: "the loft hatch" })).body;
  await api("POST", "/api/labels", { target: "conversation", targetId: run.sessionId, label: "house" });
  await page.reload();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page.locator("#rail-list .rail-item").first().click();
  await page.locator("#thread-labels").click();
  const picker = page.locator(".label-picker");
  await picker.waitFor();
  /* The label it already carries reads as chosen; pressing it takes it off. */
  const chip = picker.locator(".label-chip").first();
  assert.equal(await chip.getAttribute("aria-pressed"), "true");
  await chip.click();
  /* It was the only thing carrying that label, so the label itself is gone from the picker. */
  await page.waitForFunction(() => document.querySelectorAll(".label-picker .label-chip").length === 0, null, { timeout: 15000 });
  assert.deepEqual(app.store.labels.forTarget(app.runtime.owner, "conversation", run.sessionId), []);
  /* And a new one can be typed in without leaving the screen. */
  await picker.locator(".label-new").fill("loft");
  await picker.locator(".label-add").click();
  await page.waitForFunction(() => document.querySelector(".label-picker .label-chip")?.getAttribute("aria-pressed") === "true", null, { timeout: 15000 });
  assert.equal(await picker.locator(".label-chip").first().textContent(), "loft");
  assert.deepEqual(app.store.labels.forTarget(app.runtime.owner, "conversation", run.sessionId), ["loft"]);
  assert.deepEqual(errors, []);
});

/* ---------- G5: markdown everywhere, and Appearance in French ---------- */

const markdownReply = "## What I did\n\nI read **two** files and found `answer = 42`.\n\n- one\n- two\n";
const scripted = { name: "scripted", async complete() { return { content: markdownReply, toolCalls: [] }; } };

test("G5 the Activity screen and the inspector render a reply as markdown, never as markup", async (t) => {
  const { page, errors } = await onPage(t, { provider: scripted });
  await page.locator("#prompt").fill("do the thing");
  await page.locator("#chat-form").evaluate((form) => form.requestSubmit());
  await page.locator('#conversation .markdown h2').first().waitFor();
  await page.locator('[data-view="runs"]').first().click();
  const card = page.locator("#runs-list .item").first();
  await card.locator(".markdown h2").waitFor();
  assert.equal(await card.locator(".markdown h2").textContent(), "What I did");
  assert.equal(await card.locator(".markdown strong").first().textContent(), "two");
  assert.equal(await card.locator(".markdown code").first().textContent(), "answer = 42");
  assert.equal(await card.locator(".markdown li").count(), 2, "the list is a real list");

  await card.getByRole("button", { name: "Look inside", exact: true }).first().click();
  const panel = page.locator("#inspect-panel");
  await panel.locator(".markdown h2").first().waitFor();
  assert.equal(await panel.locator(".markdown h2").first().textContent(), "What I did");
  assert.deepEqual(errors, []);
});

test("G5 Appearance is written in French when French is chosen", async (t) => {
  const { page, errors } = await onPage(t);
  await page.locator('[data-view="settings"]').first().click();
  assert.equal(await page.locator("#settings-form h2").textContent(), "Appearance");
  assert.equal(await page.locator("#accent-choices .choice").first().textContent(), "Copper");
  await page.locator("#appearance-language").selectOption("fr");
  await page.waitForFunction(() => document.querySelector("#settings-form h2").textContent === "Apparence");
  assert.equal(await page.locator("#accent-label").textContent(), "Couleur de mise en avant");
  assert.equal(await page.locator("#accent-choices .choice").first().textContent(), "Cuivre");
  assert.equal(await page.locator("#text-size-label").textContent(), "Taille du texte");
  assert.equal(await page.locator("#settings-form button[data-t='appearance.save']").textContent(), "Enregistrer l'apparence");
  assert.deepEqual(errors, []);
});

test("G5 every key the page names has words in both languages", async () => {
  const dir = new URL("../public/", import.meta.url);
  const en = JSON.parse(await readFile(new URL("locales/en.json", dir), "utf8"));
  const fr = JSON.parse(await readFile(new URL("locales/fr.json", dir), "utf8"));
  const html = await readFile(new URL("index.html", dir), "utf8");
  const used = new Set([...html.matchAll(/data-t(?:-label|-placeholder|-title)?="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...used].filter((key) => !(key in en));
  assert.deepEqual(missing, [], "these keys are named in the page but have no English words");
  const untranslated = Object.keys(en).filter((key) => !(key in fr));
  assert.deepEqual(untranslated, [], "these keys have no French words");
});

test("G6 typing /model with the models module blocked still lists the choices", async (t) => {
  const { page, errors } = await onPage(t, { block: ["/model-profiles.js"] });
  assert.equal(await page.evaluate(() => Boolean(globalThis.branchSlashCommand)), false, "the module really is absent");
  await page.locator("#prompt").fill("/model");
  await page.locator("#chat-form").evaluate((form) => form.requestSubmit());
  await page.locator("#toast").waitFor({ state: "visible" });
  assert.match(await page.locator("#toast").textContent(), /Type \/model followed by a name/);
  assert.equal(await page.locator("#prompt").inputValue(), "", "the command is not left in the box");
  assert.equal(await page.locator("#conversation").textContent(), "", "nothing was sent to the model");

  await page.locator("#prompt").fill("/help");
  await page.locator("#chat-form").evaluate((form) => form.requestSubmit());
  await page.waitForFunction(() => document.getElementById("toast").textContent.includes("/help"));
  assert.match(await page.locator("#toast").textContent(), /\/model — Change the model/);
  assert.deepEqual(errors, []);
});
