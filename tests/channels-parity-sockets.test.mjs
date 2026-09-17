import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createSocketServer, connect as tcpConnect } from "node:net";
import { fixture, until, delay, assertNoSecret, pairingWalk, refusalWalk } from "./channels-parity-kit.mjs";
import { buildParityChannel } from "../dist/channels/parity-config.js";
import { XmppChannel } from "../dist/channels/xmpp.js";
import { XmlStreamReader, decodeEntities, escapeAttr, escapeText } from "../dist/channels/xmpp-xml.js";
import {
  schnorrSign, schnorrVerify, publicKeyOf, nip04Encrypt, nip04Decrypt, signEvent, verifyEvent, readPrivateKey,
} from "../dist/channels/nostr-crypto.js";

/**
 * The socket and local-program chat services: XMPP, MQTT, Keybase, SimpleX, Delta Chat and Nostr.
 * Every one is driven through a stand-in (a fake server on this computer, or a fake program), and
 * never through a real service or a real installed program.
 */
const XMPP_PASSWORD = "SECRET-XMPP-PASSWORD-11";

const blocked = { assertAllowed: async (url) => { throw new Error(`Not allowed: ${url.hostname}`); }, guard: (f) => f };
const policy = { activation: "mention", pairing: true, allowlist: [] };

/** A plain socket opener pointed at the stand-in, whatever host the settings name. */
const localSocket = (port, opened = []) => async (target) => new Promise((resolve, reject) => {
  opened.push(target);
  const socket = tcpConnect({ host: "127.0.0.1", port }, () => resolve(socket));
  socket.once("error", reject);
});

/** A raw TCP stand-in; `onConnect(connection)` sets up how each connection is answered. */
async function rawServer(t, onConnect) {
  const connections = [];
  const server = createSocketServer((socket) => {
    const connection = { socket, chunks: [], write: (data) => socket.write(data) };
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => { connection.chunks.push(chunk); connection.onData?.(chunk); });
    connections.push(connection);
    onConnect(connection);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { for (const c of connections) c.socket.destroy(); server.close(resolve); }));
  return { connections, port: server.address().port };
}

// ---------------------------------------------------------------- XMPP

const XMPP_HEADER = "<?xml version='1.0'?><stream:stream from='example.org' id='s1' version='1.0' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams'>";
const STANZA = /^(?:\s+|<\?xml[^>]*\?>|<stream:stream[^>]*>|<\/stream:stream>|<([\w:]+)(?:[^>"']|"[^"]*"|'[^']*')*\/>|<([\w:]+)(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\2>)/;

/**
 * A stand-in XMPP server: offers STARTTLS when asked to, checks the SASL PLAIN password, binds a
 * resource, and records every stanza the assistant sends.
 */
function xmppServer(connection, { password, starttls = false, plainOnly = false }) {
  const state = { stanzas: [], secure: false, signedIn: false, pending: "" };
  connection.xmpp = state;
  const features = () => {
    if (state.signedIn) return "<stream:features><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'/></stream:features>";
    if (starttls && !state.secure) return "<stream:features><starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'><required/></starttls></stream:features>";
    const mechanism = plainOnly ? "X-OTHER" : "PLAIN";
    return `<stream:features><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>${mechanism}</mechanism></mechanisms></stream:features>`;
  };
  const handle = (piece) => {
    state.stanzas.push(piece);
    if (piece.startsWith("<stream:stream")) connection.write(XMPP_HEADER + features());
    else if (piece.startsWith("<starttls")) { state.secure = true; connection.write("<proceed xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>"); }
    else if (piece.startsWith("<auth")) {
      const token = /<auth[^>]*>([^<]*)<\/auth>/.exec(piece)[1];
      const [, user, pass] = Buffer.from(token, "base64").toString("utf8").split("\0");
      state.user = user;
      if (pass === password) { state.signedIn = true; connection.write("<success xmlns='urn:ietf:params:xml:ns:xmpp-sasl'/>"); }
      else connection.write("<failure xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><not-authorized/></failure>");
    } else if (piece.includes("id='bind1'")) {
      connection.write("<iq type='result' id='bind1'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><jid>branch@example.org/branch</jid></bind></iq>");
    }
  };
  connection.onData = (chunk) => {
    state.pending += chunk.toString("utf8");
    for (let match = STANZA.exec(state.pending); match; match = STANZA.exec(state.pending)) {
      state.pending = state.pending.slice(match[0].length);
      if (match[0].trim()) handle(match[0]);
    }
  };
  connection.write(""); // nothing is said until the assistant opens its stream
}
const sentMessages = (connection) => connection.xmpp.stanzas.filter((s) => s.startsWith("<message"));
const bodyOf = (stanza) => decodeEntities(/<body>([\s\S]*)<\/body>/.exec(stanza)?.[1] ?? "");

function xmppChannel(port, extra = {}) {
  return new XmppChannel({ id: "xmpp", jid: "branch@example.org", password: XMPP_PASSWORD, host: "xmpp.example.org", port,
    security: "starttls", allowPlainText: true, open: localSocket(port), retryBaseMs: 20, ...extra });
}

test("XMPP XML: both quote styles, every entity form, and no document types or custom entities", () => {
  const reader = new XmlStreamReader();
  const events = [];
  const feed = (text) => reader.push(text, (event) => events.push(event));
  // Split in awkward places, as a network would.
  for (const part of [XMPP_HEADER.slice(0, 20), XMPP_HEADER.slice(20), "<message from=\"a@b/c\" type='chat'><bo", "dy>1 &lt; 2 &amp;&#65;&#x42;&quot;&apos;</body></mes", "sage> <iq type='get' id='p'/>"])
    feed(part);
  assert.equal(events[0].type, "open");
  assert.equal(events[0].attrs.from, "example.org");
  assert.equal(events[1].element.attrs.from, "a@b/c");
  assert.equal(events[1].element.attrs.type, "chat");
  assert.equal(events[1].element.children[0].text, "1 < 2 &AB\"'");
  assert.equal(events[2].element.name, "iq");
  assert.throws(() => new XmlStreamReader().push("<?xml version='1.0'?><!DOCTYPE x [<!ENTITY a 'b'>]>", () => undefined), /document type/);
  assert.throws(() => decodeEntities("&custom;"), /entity XMPP does not allow/);
  assert.throws(() => decodeEntities("&#0;"), /does not allow/);
  const later = new XmlStreamReader();
  assert.throws(() => later.push(`${XMPP_HEADER}<!ENTITY lol 'lol'>`, () => undefined), /document type/);
  assert.equal(escapeText("<b>&\u0001"), "&lt;b&gt;&amp;");
  assert.equal(escapeAttr(`"it's"`), "&quot;it&apos;s&quot;");
});

test("XMPP: signs in, pairs a stranger through real stanzas, answers them, and ignores its own address", async (t) => {
  const context = await fixture(t);
  const server = await rawServer(t, (connection) => xmppServer(connection, { password: XMPP_PASSWORD }));
  const channel = xmppChannel(server.port);
  await context.app.channels.attach(channel, policy);
  t.after(() => channel.stop());
  await until(() => channel.health().state === "connected", "signed in and bound");
  const link = server.connections[0];
  assert.equal(link.xmpp.user, "branch");
  assert.ok(link.xmpp.stanzas.includes("<presence/>"), "announces itself");

  const texts = () => sentMessages(link).map(bodyOf);
  await pairingWalk(context, { label: "XMPP", sent: texts,
    say: async (text) => link.write(`<message from='carol@example.net/phone' to='branch@example.org' type='chat' id='m${Date.now()}'><body>${escapeText(text)}</body></message>`) });
  const reply = sentMessages(link).at(-1);
  assert.match(reply, /^<message to='carol@example.net' type='chat'/, "answered at the sender's bare address as a chat");

  // Its own address (another of its devices) is never answered, and a ping is answered.
  const asked = context.provider.requests.length;
  link.write("<message from='branch@example.org/other' type='chat'><body>note to self</body></message>");
  link.write("<iq type='get' id='ping1' from='example.org'><ping xmlns='urn:xmpp:ping'/></iq>");
  await until(() => link.xmpp.stanzas.some((s) => s.includes("id='ping1'")), "the ping is answered");
  await delay(80);
  assert.equal(context.provider.requests.length, asked, "its own message is not answered");

  // Whatever a reply contains, it stays inside the body.
  await channel.send("carol@example.net", "</body></message><message to='x@y'><body>owned");
  await until(() => sentMessages(link).some((s) => s.includes("&lt;/body&gt;")), "escaped reply");
  assert.ok(!sentMessages(link).some((s) => s.startsWith("<message to='x@y'")), "no second stanza was smuggled in");
  assert.equal(sentMessages(link).at(-1).match(/<message/g).length, 1);
  await assertNoSecret(context, [XMPP_PASSWORD]);
});

test("XMPP rooms: history and the room's echo are ignored, only a message naming the nick is answered, in the room", async (t) => {
  const context = await fixture(t);
  const server = await rawServer(t, (connection) => xmppServer(connection, { password: XMPP_PASSWORD }));
  const channel = xmppChannel(server.port, { rooms: [{ room: "team@rooms.example.org", nick: "branch" }] });
  await context.app.channels.attach(channel, { activation: "mention", pairing: false, allowlist: ["dave@example.net"] });
  t.after(() => channel.stop());
  await until(() => channel.health().state === "connected", "signed in");
  const link = server.connections[0];
  await until(() => link.xmpp.stanzas.some((s) => s.startsWith("<presence to='team@rooms.example.org/branch'") && s.includes("maxstanzas='0'")), "joined the room");
  const from = "from='team@rooms.example.org/dave' type='groupchat'";
  const real = "<x xmlns='http://jabber.org/protocol/muc#user'><item jid='dave@example.net/laptop'/></x>";
  link.write(`<message ${from}><body>branch: an old question</body><delay xmlns='urn:xmpp:delay' stamp='2020-01-01T00:00:00Z'/>${real}</message>`);
  link.write(`<message from='team@rooms.example.org/branch' type='groupchat'><body>branch: my own words</body></message>`);
  link.write(`<message ${from}><body>lunch anyone?</body>${real}</message>`);
  await delay(150);
  assert.equal(context.provider.requests.length, 0, "history, echo and unaddressed talk are left alone");
  link.write(`<message ${from} id='g1'><body>branch: what is the plan</body>${real}</message>`);
  await until(() => sentMessages(link).some((s) => /Echo:.*what is the plan/.test(bodyOf(s))), "answered in the room");
  assert.match(sentMessages(link).at(-1), /^<message to='team@rooms.example.org' type='groupchat'/);
  await assertNoSecret(context, [XMPP_PASSWORD]);
});

test("XMPP: a stranger is refused when pairing is off", async (t) => {
  const context = await fixture(t);
  const server = await rawServer(t, (connection) => xmppServer(connection, { password: XMPP_PASSWORD }));
  const channel = xmppChannel(server.port);
  await context.app.channels.attach(channel, { activation: "mention", pairing: false, allowlist: [] });
  t.after(() => channel.stop());
  await until(() => channel.health().state === "connected", "signed in");
  const link = server.connections[0];
  await refusalWalk(context, { label: "XMPP", sent: () => sentMessages(link).map(bodyOf),
    say: async (text) => link.write(`<message from='mallory@evil.example/x' type='chat'><body>${text}</body></message>`) });
  await assertNoSecret(context, [XMPP_PASSWORD]);
});

test("XMPP: STARTTLS comes before the password, no password goes out unencrypted, and a wrong one is said plainly", async (t) => {
  const context = await fixture(t);
  const tlsServer = await rawServer(t, (connection) => xmppServer(connection, { password: XMPP_PASSWORD, starttls: true }));
  const upgrades = [];
  const secured = new XmppChannel({ id: "tls", jid: "branch@example.org", password: XMPP_PASSWORD, host: "h", port: tlsServer.port,
    security: "starttls", open: localSocket(tlsServer.port), upgrade: async (socket, name) => { upgrades.push(name); return socket; } });
  await secured.start(async () => undefined);
  t.after(() => secured.stop());
  await until(() => secured.health().state === "connected", "signed in after STARTTLS");
  const stanzas = tlsServer.connections[0].xmpp.stanzas;
  assert.deepEqual(upgrades, ["example.org"]);
  assert.ok(stanzas.findIndex((s) => s.startsWith("<starttls")) < stanzas.findIndex((s) => s.startsWith("<auth")), "encryption first");
  assert.equal(stanzas.filter((s) => s.startsWith("<stream:stream")).length, 3, "the stream restarts after TLS and after sign-in");

  const plainServer = await rawServer(t, (connection) => xmppServer(connection, { password: XMPP_PASSWORD }));
  const careful = new XmppChannel({ id: "plain", jid: "branch@example.org", password: XMPP_PASSWORD, host: "h", port: plainServer.port,
    security: "starttls", open: localSocket(plainServer.port) });
  await careful.start(async () => undefined);
  t.after(() => careful.stop());
  await until(() => careful.health().state === "needs attention", "refuses to sign in unencrypted");
  assert.match(careful.health().reason, /does not offer encryption/);
  assert.ok(!Buffer.concat(plainServer.connections[0].chunks).toString().includes("<auth"), "the password never left");

  const wrongServer = await rawServer(t, (connection) => xmppServer(connection, { password: "another-password" }));
  const wrong = xmppChannel(wrongServer.port);
  await wrong.start(async () => undefined);
  t.after(() => wrong.stop());
  await until(() => wrong.health().state === "needs attention", "a refused password is reported");
  assert.match(wrong.health().reason, /did not accept the password/);
  assert.ok(!wrong.health().reason.includes(XMPP_PASSWORD));
  await delay(100);
  assert.equal(wrongServer.connections.length, 1, "a refused password is not tried again and again");
  await context.app.channels.attach(wrong, policy);
  await assertNoSecret(context, [XMPP_PASSWORD]);
});

test("XMPP settings: the server name is checked before anything opens, and the password is a secret name", async (t) => {
  await assert.rejects(() => buildParityChannel({ type: "xmpp", id: "x", jid: "branch@chat.example.org", ...policy },
    { credential: async () => "x", policy: blocked }), /Not allowed: chat.example.org/);
  await assert.rejects(() => buildParityChannel({ type: "xmpp", id: "x", jid: "branch@chat.example.org", server: "xmpp.example.net", ...policy },
    { credential: async () => "x", policy: blocked }), /Not allowed: xmpp.example.net/);
  await assert.rejects(() => buildParityChannel({ type: "xmpp", id: "x", jid: "branch@chat.example.org", password: "hunter2", ...policy },
    { credential: async () => "x" }), /password|Unrecognized/i, "a password value is never a setting");
  const asked = [];
  const opened = [];
  const channel = await buildParityChannel({ type: "xmpp", id: "x", jid: "branch@chat.example.org", ...policy },
    { credential: async (name) => { asked.push(name); return XMPP_PASSWORD; }, openSocket: localSocket(1, opened) });
  assert.deepEqual(asked, ["XMPP_PASSWORD"]);
  assert.equal(channel.kind, "xmpp");
  await channel.stop();
  assert.equal(opened.length, 0, "a switched-off service opens nothing");
});

// ---------------------------------------------------------------- Nostr cryptography

/** The official BIP-340 vectors (bitcoin/bips bip-0340/test-vectors.csv). */
const BIP340 = [
  [0, "0000000000000000000000000000000000000000000000000000000000000003", "F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9", "0000000000000000000000000000000000000000000000000000000000000000", "0000000000000000000000000000000000000000000000000000000000000000", "E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA821525F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0", true],
  [1, "B7E151628AED2A6ABF7158809CF4F3C762E7160F38B4DA56A784D9045190CFEF", "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659", "0000000000000000000000000000000000000000000000000000000000000001", "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", "6896BD60EEAE296DB48A229FF71DFE071BDE413E6D43F917DC8DCF8C78DE33418906D11AC976ABCCB20B091292BFF4EA897EFCB639EA871CFA95F6DE339E4B0A", true],
  [2, "C90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B14E5C9", "DD308AFEC5777E13121FA72B9CC1B7CC0139715309B086C960E18FD969774EB8", "C87AA53824B4D7AE2EB035A2B5BBBCCC080E76CDC6D1692C4B0B62D798E6D906", "7E2D58D8B3BCDF1ABADEC7829054F90DDA9805AAB56C77333024B9D0A508B75C", "5831AAEED7B44BB74E5EAB94BA9D4294C49BCF2A60728D8B4C200F50DD313C1BAB745879A5AD954A72C45A91C3A51D3C7ADEA98D82F8481E0E1E03674A6F3FB7", true],
  [3, "0B432B2677937381AEF05BB02A66ECD012773062CF3FA2549E44F58ED2401710", "25D1DFF95105F5253C4022F628A996AD3A0D95FBF21D468A1B33F8C160D8F517", "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF", "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF", "7EB0509757E246F19449885651611CB965ECC1A187DD51B64FDA1EDC9637D5EC97582B9CB13DB3933705B32BA982AF5AF25FD78881EBB32771FC5922EFC66EA3", true],
  [4, "", "D69C3509BB99E412E68B0FE8544E72837DFA30746D8BE2AA65975F29D22DC7B9", "", "4DF3C3F68FCC83B27E9D42C90431A72499F17875C81A599B566C9889B9696703", "00000000000000000000003B78CE563F89A0ED9414F5AA28AD0D96D6795F9C6376AFB1548AF603B3EB45C9F8207DEE1060CB71C04E80F593060B07D28308D7F4", true],
  [5, "", "EEFDEA4CDB677750A420FEE807EACF21EB9898AE79B9768766E4FAA04A2D4A34", "", "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", "6CFF5C3BA86C69EA4B7376F31A9BCB4F74C1976089B2D9963DA2E5543E17776969E89B4C5564D00349106B8497785DD7D1D713A8AE82B32FA79D5F7FC407D39B", false],
  [6, "", "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659", "", "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", "FFF97BD5755EEEA420453A14355235D382F6472F8568A18B2F057A14602975563CC27944640AC607CD107AE10923D9EF7A73C643E166BE5EBEAFA34B1AC553E2", false],
  [7, "", "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659", "", "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", "1FA62E331EDBC21C394792D2AB1100A7B432B013DF3F6FF4F99FCB33E0E1515F28890B3EDB6E7189B630448B515CE4F8622A954CFE545735AAEA5134FCCDB2BD", false],
  [8, "", "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659", "", "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", "6CFF5C3BA86C69EA4B7376F31A9BCB4F74C1976089B2D9963DA2E5543E177769961764B3AA9B2FFCB6EF947B6887A226E8D7C93E00C5ED0C1834FF0D0C2E6DA6", false],
  [9, "", "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659", "", "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", "0000000000000000000000000000000000000000000000000000000000000000123DDA8328AF9C23A94C1FEECFD123BA4FB73476F0D594DCB65C6425BD186051", false],
  [10, "", "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659", "", "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", "00000000000000000000000000000000000000000000000000000000000000017615FBAF5AE28864013C099742DEADB4DBA87F11AC6754F93780D5A1837CF197", false],
  [11, "", "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659", "", "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", "4A298DACAE57395A15D0795DDBFD1DCB564DA82B0F269BC70A74F8220429BA1D69E89B4C5564D00349106B8497785DD7D1D713A8AE82B32FA79D5F7FC407D39B", false],
  [12, "", "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659", "", "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F69E89B4C5564D00349106B8497785DD7D1D713A8AE82B32FA79D5F7FC407D39B", false],
  [13, "", "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659", "", "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", "6CFF5C3BA86C69EA4B7376F31A9BCB4F74C1976089B2D9963DA2E5543E177769FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141", false],
  [14, "", "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC30", "", "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", "6CFF5C3BA86C69EA4B7376F31A9BCB4F74C1976089B2D9963DA2E5543E17776969E89B4C5564D00349106B8497785DD7D1D713A8AE82B32FA79D5F7FC407D39B", false],
];
const hex = (value) => Buffer.from(value, "hex");

test("Nostr: BIP-340 signing and verification match the official test vectors", () => {
  for (const [index, secret, publicKey, aux, message, signature, valid] of BIP340) {
    if (secret) {
      assert.equal(publicKeyOf(hex(secret)).toString("hex").toUpperCase(), publicKey, `vector ${index}: public key`);
      assert.equal(schnorrSign(hex(message), hex(secret), hex(aux)).toString("hex").toUpperCase(), signature, `vector ${index}: signature`);
    }
    assert.equal(schnorrVerify(hex(signature), hex(message), hex(publicKey)), valid, `vector ${index}: verification`);
  }
  assert.throws(() => publicKeyOf(Buffer.alloc(32)), /not a valid key/);
});

test("Nostr: NIP-04 messages round-trip between two keys, events verify, and an nsec key is read", () => {
  const alice = Buffer.alloc(32, 7), bob = Buffer.alloc(32, 9);
  const sealed = nip04Encrypt(alice, publicKeyOf(bob).toString("hex"), "meet at noon ✓");
  assert.match(sealed, /^[A-Za-z0-9+/=]+\?iv=[A-Za-z0-9+/=]{24}$/);
  assert.equal(nip04Decrypt(bob, publicKeyOf(alice).toString("hex"), sealed), "meet at noon ✓");
  assert.throws(() => nip04Decrypt(bob, publicKeyOf(bob).toString("hex"), sealed));
  const event = signEvent({ created_at: 1700000000, kind: 4, tags: [["p", "ab"]], content: "line\n\"quoted\"" }, alice);
  assert.equal(verifyEvent(event), true);
  assert.equal(verifyEvent({ ...event, content: "changed" }), false, "a changed event fails its id");
  assert.equal(verifyEvent({ ...event, sig: event.sig.replace(/^./, (c) => (c === "0" ? "1" : "0")) }), false, "a changed signature fails");
  // The NIP-19 example key.
  assert.equal(readPrivateKey("nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5").toString("hex"),
    "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa");
  assert.throws(() => readPrivateKey("nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe6"), /not written correctly/);
});
