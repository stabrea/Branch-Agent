// The phone app against the real server, through the paired door (src/server.ts remoteHandler):
// the pairing body the app sends is the one the server takes, the harmless file the app loads before
// opening the window needs no key, and what "Send to Branch" and the notification check send are
// accepted. No phone and no network beyond this computer.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { newAttention, pairingBody, planShare, readInvitation } from "../apps/mobile/web/rules.js";
import { discardTemp } from "./temp-dir.mjs";

async function pairedDoor(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-mobile-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } },
  });
  const handle = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  // The paired door answers on the Tailscale address in use; here a spare loopback port stands in,
  // carrying a host the server accepts, because the host check comes first by design.
  const host = new URL(handle.url).host;
  const door = createServer((request, response) => { request.headers.host = host; handle.remoteHandler(request, response); });
  await new Promise((done) => door.listen(0, "127.0.0.1", done));
  t.after(async () => {
    door.closeAllConnections?.();
    await new Promise((done) => door.close(done));
    await handle.close(); await app.close(); await discardTemp(root);
  });
  return { handle, base: `http://127.0.0.1:${door.address().port}` };
}

async function pairPhone(handle, base) {
  const offer = handle.remote.pairing.create();
  const answer = await post(base, "/api/pair", pairingBody(offer.id, offer.code, "Pixel"));
  const session = await answer.json();
  return { authorization: `Bearer ${session.token}`, "x-branch-device": session.deviceId, "x-branch-device-key": session.deviceKey };
}

const post = (base, path, body, headers = {}) => fetch(base + path, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});

test("the phone pairs with the body it builds, and its key then works on the paired door", async (t) => {
  const { handle, base } = await pairedDoor(t);
  const offer = handle.remote.pairing.create();
  const invitation = readInvitation(`${base}/pair?id=${offer.id}`);
  assert.equal(invitation.origin, base);
  const wrong = await post(base, "/api/pair", pairingBody(offer.id, offer.code === "000000" ? "111111" : "000000", "Pixel"));
  assert.equal(wrong.status, 400);
  const answer = await post(base, "/api/pair", pairingBody(invitation.offerId, offer.code, "Pixel"));
  assert.equal(answer.status, 200);
  const session = await answer.json();
  assert.equal(typeof session.token, "string");
  assert.match(session.deviceId, /^[a-f0-9]{16}$/);
  assert.equal(typeof session.deviceKey, "string");

  // The harmless file the app opens first, to write the key into the paired address's own storage.
  const primer = await fetch(`${base}/tokens.css`);
  assert.equal(primer.status, 200);
  assert.match(primer.headers.get("content-type"), /text\/css/);
  assert.notEqual((await fetch(`${base}/inject.js`)).status, 200, "the phone's page script is the app's, not the server's");

  const headers = { authorization: `Bearer ${session.token}`, "x-branch-device": session.deviceId, "x-branch-device-key": session.deviceKey };
  const state = await (await fetch(`${base}/api/state`, { headers })).json();
  assert.deepEqual(newAttention(state, []), []);
  assert.equal((await fetch(`${base}/api/state`)).status, 401, "nothing without the key");
});

test("what Send to Branch sends is accepted: a message with a picture, and a document", async (t) => {
  const { handle, base } = await pairedDoor(t);
  const headers = await pairPhone(handle, base);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const { requests } = planShare([
    { kind: "url", text: "https://example.com/from-my-phone" },
    { kind: "file", name: "dot.png", type: "image/png", data: png },
    { kind: "file", name: "note.txt", type: "text/plain", data: Buffer.from("Shared from the phone").toString("base64") },
  ], "Please look");
  assert.deepEqual(requests.map((each) => each.path), ["/api/run", "/api/documents"]);
  for (const request of requests) {
    const answer = await post(base, request.path, request.body, headers);
    assert.equal(answer.status, 200, `${request.path}: ${await answer.clone().text()}`);
  }
  const documents = await (await fetch(`${base}/api/documents`, { headers })).json();
  assert.ok(documents.documents.some((each) => each.name === "note.txt"));
});
