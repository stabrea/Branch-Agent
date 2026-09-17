import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fixture, until, delay, httpService, socketService } from "./channels-parity-kit.mjs";
import { SlackAdapter } from "../dist/channels/slack.js";
import { SlackAutomations, slackAutomationSettings, saveSlackAutomations } from "../dist/channels/slack-automations.js";
import { startServer } from "../dist/server.js";

/**
 * mac6/bucket-16: automations started by Slack's own events, over the Socket Mode connection the
 * Slack channel already holds. Off by default; "when needed" only lists; "on" starts them.
 */
const reaction = (extra = {}) => ({ type: "reaction_added", user: "UALICE", reaction: "rocket", item: { type: "message", channel: "CDEPLOY", ts: "1700.1" }, ...extra });

function trigger(app, prompt = "Slack said {{slack_type}} with {{slack_reaction}} in {{slack_channel}}{{slack_text}}") {
  return app.triggers.create(app.runtime.context(), { name: "From Slack", prompt, rateLimitPerMinute: 30 });
}
/** The same save the route makes, so the rules are checked against the automations that exist. */
const save = async (app, input) => saveSlackAutomations(app.store, app.runtime.owner, input, (id) => !!app.triggers.get(app.runtime.owner, id));

test("off starts nothing, on starts the matching automation with the event in its prompt, and filters are honoured", async (t) => {
  const { app, provider } = await fixture(t);
  const fired = trigger(app);
  assert.deepEqual(slackAutomationSettings(app.store, app.runtime.owner), { mode: "off", rules: [] }, "ships off with no rules");
  await save(app, { rules: [{ event: "reaction_added", reaction: "rocket", channel: "CDEPLOY", users: ["UALICE"], trigger: fired.id }] });
  assert.equal(await app.slackAutomations.handle("slack", reaction(), "UBOT"), 0, "still off: nothing starts");
  assert.equal(provider.requests.length, 0);

  await save(app, { mode: "on" });
  assert.equal(await app.slackAutomations.handle("slack", reaction({ reaction: "eyes" }), "UBOT"), 0, "another reaction");
  assert.equal(await app.slackAutomations.handle("slack", reaction({ user: "UMALLORY" }), "UBOT"), 0, "somebody not on the list");
  assert.equal(await app.slackAutomations.handle("slack", reaction({ item: { channel: "COTHER" } }), "UBOT"), 0, "another channel");
  assert.equal(await app.slackAutomations.handle("slack", reaction({ user: "UBOT" }), "UBOT"), 0, "the assistant's own reaction");
  assert.equal(await app.slackAutomations.handle("slack", reaction({ bot_id: "B1" }), "UBOT"), 0, "another bot");
  assert.equal(await app.slackAutomations.handle("slack", { nonsense: true }, "UBOT"), 0);
  assert.equal(provider.requests.length, 0);

  assert.equal(await app.slackAutomations.handle("slack", reaction(), "UBOT"), 1);
  const prompt = provider.requests.at(-1).messages.at(-1).content;
  assert.match(prompt, /Slack said reaction_added with rocket in CDEPLOY/);
  assert.equal(app.triggers.getLog(fired.id, app.runtime.owner).length, 1, "the start is written in the automation's log");
});

test("when needed, matching events only wait in a list until one is started by hand", async (t) => {
  const { app, provider } = await fixture(t);
  const fired = trigger(app, "Summarise: {{slack_text}}");
  await save(app, { mode: "when-needed", rules: [{ event: "message", contains: "deploy", users: ["UALICE"], trigger: fired.id }] });
  await app.slackAutomations.handle("slack", { type: "message", user: "UALICE", channel: "C1", text: "please DEPLOY the site", ts: "1.1" }, "UBOT");
  await app.slackAutomations.handle("slack", { type: "message", user: "UALICE", channel: "C1", text: "lunch?", ts: "1.2" }, "UBOT");
  assert.equal(provider.requests.length, 0, "nothing starts by itself");
  const { waiting } = app.slackAutomations.list();
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].event.text, "please DEPLOY the site");
  await app.slackAutomations.run({ event: waiting[0].id });
  assert.match(provider.requests.at(-1).messages.at(-1).content, /Summarise: <slack-message from="UALICE" trust="untrusted">\nplease DEPLOY the site\n/);
  await assert.rejects(() => app.slackAutomations.run({ event: waiting[0].id }), /no longer waiting/, "each waiting event starts once");
  await save(app, { mode: "off" });
  await assert.rejects(() => app.slackAutomations.run({ event: waiting[0].id }), /switched off/);
});

test("a rule must name an automation that exists, and settings are strict", async (t) => {
  const { app } = await fixture(t);
  await assert.rejects(() => save(app, { rules: [{ event: "reaction_added", trigger: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f" }] }), /no automation/);
  await assert.rejects(() => save(app, { mode: "sometimes" }));
  await assert.rejects(() => save(app, { rules: [{ event: "reaction_added", trigger: trigger(app).id, command: "rm -rf" }] }));
  const broken = new SlackAutomations({ get: () => ({ data: { mode: "on", rules: "nonsense" } }), save: () => undefined }, () => "local", async () => { throw new Error("never"); });
  assert.equal(await broken.handle("slack", reaction()), 0, "a damaged record reads as off");
});

test("the Slack channel hands every event to the automations as well as answering, without Slack reaching this computer", async (t) => {
  const { app, provider } = await fixture(t);
  const fired = trigger(app);
  await save(app, { mode: "on", rules: [{ event: "reaction_added", users: ["UALICE"], trigger: fired.id }] });
  const socket = await socketService(t, (connection) => connection.send({ type: "hello" }));
  const api = await httpService(t, (call) => {
    if (call.path.endsWith("auth.test")) return { body: { ok: true, user_id: "UBOT", user: "branch" } };
    if (call.path.endsWith("chat.postMessage")) return { body: { ok: true, ts: "1.0" } };
    return undefined;
  });
  const adapter = new SlackAdapter({ id: "slack", token: "xoxb-test", appToken: "xapp-test", apiBase: api.base, socketUrl: socket.url,
    reconnectBaseMs: 10, onEvent: (event, bot) => app.channelHost.slackEvents("slack", event, bot) });
  await app.channels.attach(adapter, { activation: "mention", pairing: false, allowlist: [] });
  t.after(() => adapter.stop());
  const link = await until(() => socket.connections[0], "socket");
  await until(() => adapter.health().state === "connected", "connected");
  link.send({ type: "events_api", envelope_id: "e1", payload: { event_id: "ev1", event: reaction() } });
  await until(() => provider.requests.some((r) => /Slack said reaction_added/.test(r.messages.at(-1).content)), "the automation started");
  link.send({ type: "events_api", envelope_id: "e2", payload: { event_id: "ev1", event: reaction() } });
  await until(() => link.received.some((m) => m.envelope_id === "e2"), "the resend is acknowledged");
  await delay(100);
  assert.equal(provider.requests.length, 1, "Slack's resend of the same event starts nothing twice");
  link.send({ type: "events_api", envelope_id: "e3", payload: { event_id: "ev3", event: reaction({ user: "UBOT" }) } });
  await delay(100);
  assert.equal(provider.requests.length, 1, "the assistant's own reaction starts nothing");
});

test("the settings route is the owner's; a script's run key may start a waiting event but not change the rules", async (t) => {
  const context = await fixture(t);
  const { app } = context;
  const fired = trigger(app);
  const server = await startServer(app, { dataDir: join(context.root, "data"), port: 0 });
  t.after(() => server.close());
  const owner = { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" };
  const saved = await fetch(`${server.url}/api/channels/slack-automations`, { method: "POST", headers: owner,
    body: JSON.stringify({ mode: "when-needed", rules: [{ event: "reaction_added", users: ["UALICE"], trigger: fired.id }] }) });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).mode, "when-needed");
  await app.slackAutomations.handle("slack", reaction(), "UBOT");
  const key = app.sessionTokens.create(app.runtime.owner, { scope: "run", minutes: 5 });
  const script = { authorization: `Bearer ${key.token}`, "content-type": "application/json" };
  // Integration review (bucket 19 merge): the waiting events carry Slack text, so only the owner lists them.
  assert.equal((await fetch(`${server.url}/api/channels/slack-automations`, { headers: script })).status, 401, "a run key cannot read the waiting events");
  const listed = await fetch(`${server.url}/api/channels/slack-automations`, { headers: owner }).then((r) => r.json());
  assert.equal(listed.waiting.length, 1);
  const changed = await fetch(`${server.url}/api/channels/slack-automations`, { method: "POST", headers: script, body: JSON.stringify({ mode: "on" }) });
  assert.equal(changed.status, 401, "a run key cannot change the rules");
  const started = await fetch(`${server.url}/api/channels/slack-automations/run`, { method: "POST", headers: script,
    body: JSON.stringify({ event: listed.waiting[0].id }) });
  assert.equal(started.status, 200, "a run key may start what is waiting");
  assert.ok((await started.json()).runId);
  const bad = await fetch(`${server.url}/api/channels/slack-automations`, { method: "POST", headers: owner,
    body: JSON.stringify({ rules: [{ event: "reaction_added", trigger: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f" }] }) });
  assert.ok(bad.status >= 400 && bad.status < 500);
});
