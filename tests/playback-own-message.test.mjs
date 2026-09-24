import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/** Q85 (FQ-surfaces.playback): a clip goes to the message the server saved for this send, the id
 *  POST /api/run returns as `userMessageId`, and never to a message a linked chat saved in between.
 *  The real server and the real public/playback.js, driven the way public/app.js drives them; only
 *  the DOM is a double, so no browser is started. */

const playback = await readFile(new URL("../public/playback.js", import.meta.url), "utf8");
const clip = { kind: "audio", mediaType: "audio/wav", name: "note.wav", url: "blob:note.wav" };

function node(tag) {
  return { tag, children: [], className: "", append(...more) { this.children.push(...more); }, replaceChildren() { this.children = []; } };
}
/** A page: public/playback.js loaded on its own, with its own memory of which message carried what. */
function page() {
  const context = createContext({
    document: { getElementById: () => null, createElement: node },
    URL: { createObjectURL: () => "blob:unused", revokeObjectURL() {} },
  });
  runInContext(playback, context);
  return context;
}
const players = (bubble) => bubble.children.filter((child) => child.className === "message-clips")
  .flatMap((wrap) => wrap.children.map((player) => player.tag));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-playback-own-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Heard it.", toolCalls: [] }; } },
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const headers = { authorization: "Bearer " + server.token, "content-type": "application/json", origin: server.url };
  const call = async (path, body) => {
    const response = await fetch(server.url + path, body ? { method: "POST", headers, body: JSON.stringify(body) } : { headers });
    assert.equal(response.status, 200, `${path} answers`);
    return response.json();
  };
  return { app, call };
}
/** What public/app.js does once a send comes back: hand the clips over, redraw from what the server
 *  saved (every user message, in order), then settle whatever was not matched. */
async function sendAndRedraw(tab, call, body, clips) {
  const run = await call("/api/run", body);
  tab.branchPlaybackExpect(run.sessionId, clips, run.userMessageId ?? undefined);
  const view = await call("/api/sessions/" + run.sessionId);
  const bubbles = new Map();
  for (const source of view.messages.filter((entry) => entry.role === "user")) {
    const bubble = node("div");
    tab.branchPlaybackRender(bubble, run.sessionId, source);
    bubbles.set(source.content, { id: source.messageId, players: players(bubble) });
  }
  tab.branchPlaybackSettle();
  return { run, bubbles };
}

test("a clip goes to this send's own saved message, not to one a linked chat saved in between", async (t) => {
  const { app, call } = await fixture(t);
  const tab = page();
  const first = await sendAndRedraw(tab, call, { prompt: "first, with no file" }, []);
  const sessionId = first.run.sessionId;
  // A linked chat shares this conversation's history (src/channels/router.ts): it saves a message
  // after this page's last redraw and before the next send is saved.
  app.store.message(sessionId, { role: "user", content: "from the linked chat" });
  const second = await sendAndRedraw(tab, call, { prompt: "second, with a note", sessionId }, [clip]);

  assert.equal(second.run.sessionId, sessionId, "the run's own fields are still there");
  assert.equal(second.run.status, "completed");
  const older = second.bubbles.get("first, with no file");
  const linked = second.bubbles.get("from the linked chat");
  const own = second.bubbles.get("second, with a note");
  assert.equal(typeof second.run.userMessageId, "number", "POST /api/run says which message it saved");
  assert.equal(second.run.userMessageId, own.id, "and it is the one the conversation shows for this send");
  assert.ok(older.id < linked.id && linked.id < own.id, "the linked chat's message was saved in between");
  assert.deepEqual(linked.players, [], "the linked chat's message never takes this send's clip");
  assert.deepEqual(own.players, ["audio"], "this send's own message plays it");
  assert.deepEqual(older.players, []);

  // A page that never drew this conversation gives the clip to this send's message, not an older one.
  const third = await sendAndRedraw(page(), call, { prompt: "third, from a page that never drew it", sessionId }, [clip]);
  assert.deepEqual(third.bubbles.get("third, from a page that never drew it").players, ["audio"]);
  assert.deepEqual(third.bubbles.get("first, with no file").players, []);
  assert.deepEqual(third.bubbles.get("from the linked chat").players, []);
});
