import test from "node:test";
import assert from "node:assert/strict";
import {
  fixture, until, delay, setSwitch, assertNoSecret, httpService, pairingWalk, refusalWalk,
} from "./channels-parity-kit.mjs";
import { buildParityChannel } from "../dist/channels/parity-config.js";
import { MastodonChannel, mastodonText, dropLeadingMentions } from "../dist/channels/mastodon.js";

/**
 * The social services (Mastodon, Bluesky, Reddit, Discourse, X, Twist) are tested against stand-in
 * servers that answer the way each service's documentation says. No real service is contacted.
 */
const MASTODON_TOKEN = "SECRET-MASTODON-TOKEN-11";

const blocked = { assertAllowed: async (url) => { throw new Error(`Not allowed: ${url.hostname}`); }, guard: (f) => f };
const policy = { activation: "mention", pairing: true, allowlist: [] };

/** Attaches a channel, stops it when the test ends, and waits for its first look to finish. */
async function attach(t, context, channel, options = policy) {
  await context.app.channels.attach(channel, options);
  t.after(() => channel.stop());
  await until(() => channel.health().state === "connected", `${channel.kind}: first look`);
  await delay(60);
}

/** Proves the settings are strict and the network check is asked about the service's own host. */
async function settingsAreChecked(context, config, host, secret) {
  const full = { ...config, activation: "mention", pairing: true, allowlist: [] };
  await assert.rejects(() => buildParityChannel(full, { credential: async () => secret, policy: blocked }),
    new RegExp(`Not allowed: ${host.replace(/\./g, "\\.")}`));
  await assert.rejects(() => buildParityChannel({ ...full, token: secret }, { credential: async () => secret }),
    /token|Unrecognized/i, "a secret value is never a setting");
  const built = await buildParityChannel(full, { credential: async () => secret, store: context.app.store, owner: context.app.runtime.owner });
  assert.equal(built.health().state, "needs attention", "a new service starts switched off");
  return built;
}

// ---------------------------------------------------------------------------------------------
// Mastodon

function mastodonServer(t, { token = MASTODON_TOKEN } = {}) {
  const notes = [];
  const posts = [];
  let next = 100;
  const account = (id, acct) => ({ id, acct, username: acct.split("@")[0], display_name: acct });
  const mention = (from, text, { visibility = "direct", fromId = "7" } = {}) => {
    const id = String(next++);
    notes.push({ id, type: "mention", account: account(fromId, from),
      status: { id: `9${id}`, visibility, account: account(fromId, from),
        content: `<p><span class="h-card"><a href="https://social.example/@branch" class="u-url mention">@<span>branch</span></a></span> ${text.replace(/&/g, "&amp;")}</p>` } });
  };
  return httpService(t, (call) => {
    if (call.headers.authorization !== `Bearer ${token}`) return { status: 401, body: { error: "The access token is invalid" } };
    if (call.path === "/api/v1/accounts/verify_credentials") return { body: account("1", "branch") };
    if (call.path === "/api/v1/notifications") {
      const since = call.query.since_id ? BigInt(call.query.since_id) : -1n;
      return { body: notes.filter((n) => BigInt(n.id) > since).reverse() };
    }
    if (call.path === "/api/v1/statuses" && call.method === "POST") {
      posts.push(call);
      return { body: { id: `5${posts.length}` } };
    }
    if (call.path.startsWith("/api/v1/statuses/")) {
      const status = notes.map((n) => n.status).find((s) => s.id === call.path.split("/").at(-1));
      return status ? { body: status } : undefined;
    }
    return undefined;
  }).then((service) => ({ ...service, notes, posts, mention }));
}

test("Mastodon: status HTML becomes plain words, and the assistant's own name is dropped", () => {
  assert.equal(mastodonText("<p>one<br>two &amp; &lt;three&gt; &#39;q&#39; &#x1F600;</p><p>next</p>"), "one\ntwo & <three> 'q' 😀\n\nnext");
  assert.equal(mastodonText("<p>&#0; &#99999999; &bogus;</p>"), " &bogus;".trim());
  assert.equal(dropLeadingMentions("@branch @Branch@social.example, hello @branch", "branch"), "hello @branch");
  assert.equal(dropLeadingMentions("@branchy hi", "branch"), "@branchy hi");
});

test("Mastodon: history is left alone, a stranger pairs, and replies mention them with their own visibility", async (t) => {
  const context = await fixture(t);
  const server = await mastodonServer(t);
  server.mention("old@elsewhere.example", "from before Branch started");
  const channel = new MastodonChannel({ id: "mastodon", instance: `${server.base}/`, token: MASTODON_TOKEN, pollMs: 20 });
  await attach(t, context, channel);
  assert.equal(server.posts.length, 0, "the mention from before Branch started is not answered");
  assert.equal(channel.botName(), "branch");

  const said = () => server.posts.map((p) => p.json.status);
  await pairingWalk(context, { label: "Mastodon", say: async (text) => server.mention("carol@other.example", text), sent: said });
  const last = server.posts.at(-1);
  assert.equal(last.json.status, "@carol@other.example Echo: what is the time", "the @mention is not part of the words");
  assert.equal(last.json.visibility, "direct", "a private mention is answered privately");
  assert.equal(last.json.in_reply_to_id, server.notes.at(-1).status.id);
  assert.match(last.headers["idempotency-key"], /^[0-9a-f]{64}$/);

  // A mention by the assistant's own account is never answered.
  const asked = context.provider.requests.length;
  server.mention("branch", "talking to myself", { fromId: "1" });
  await delay(150);
  assert.equal(context.provider.requests.length, asked);

  // A public mention is answered publicly, in the thread, and a long answer's later pieces follow it.
  server.mention("carol@other.example", "a public question", { visibility: "public" });
  await until(() => server.posts.some((p) => p.json.visibility === "public"), "a public answer");
  const publicPost = server.posts.find((p) => p.json.visibility === "public");
  const status = server.notes.at(-1).status.id;
  assert.equal(publicPost.json.in_reply_to_id, status);
  await channel.send(status, "x".repeat(700));
  assert.equal(server.posts.at(-1).json.in_reply_to_id, status, "a piece with no reply target follows the thread");
  assert.ok(server.posts.at(-1).json.status.length <= 500, "the server's limit is kept");
  await assertNoSecret(context, [MASTODON_TOKEN]);
});

test("Mastodon: a stranger is refused when pairing is off, and a refused token is reported plainly", async (t) => {
  const context = await fixture(t);
  const server = await mastodonServer(t);
  const channel = new MastodonChannel({ id: "mastodon", instance: server.base, token: MASTODON_TOKEN, pollMs: 20 });
  await attach(t, context, channel, { ...policy, pairing: false });
  await refusalWalk(context, { label: "Mastodon", say: async (text) => server.mention("mallory@bad.example", text),
    sent: () => server.posts.map((p) => p.json.status) });
  assert.equal(server.posts.at(-1).json.visibility, "direct");

  const wrong = await mastodonServer(t, { token: "some-other-token" });
  const refused = new MastodonChannel({ id: "refused", instance: wrong.base, token: MASTODON_TOKEN, pollMs: 20 });
  await refused.start(async () => undefined);
  t.after(() => refused.stop());
  await until(() => refused.health().state === "needs attention", "the refusal is reported");
  assert.match(refused.health().reason, /MASTODON_ACCESS_TOKEN/);
  await assertNoSecret(context, [MASTODON_TOKEN]);
});

test("Mastodon: the connections file takes the server and a secret name, and the network check sees the server", async (t) => {
  const context = await fixture(t);
  const server = await mastodonServer(t);
  await settingsAreChecked(context, { type: "mastodon", id: "masto", instance: "https://social.example.org" }, "social.example.org", MASTODON_TOKEN);
  const built = await buildParityChannel({ type: "mastodon", id: "masto", instance: server.base, pollSeconds: 10, ...policy },
    { credential: async (name) => (name === "MASTODON_ACCESS_TOKEN" ? MASTODON_TOKEN : ""), store: context.app.store, owner: context.app.runtime.owner });
  setSwitch(context.app, "mastodon", "on");
  await context.app.channels.attach(built, policy);
  t.after(() => built.stop());
  await until(() => built.health().state === "connected", "connected with the saved token");
  assert.ok(server.calls.every((c) => c.headers.authorization === `Bearer ${MASTODON_TOKEN}` && !c.path.includes(MASTODON_TOKEN)));
  await assertNoSecret(context, [MASTODON_TOKEN]);
});
