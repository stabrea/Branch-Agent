import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { once } from "node:events";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

test("shutdown closes browser preconnections after draining runtime work", async () => {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-server-close-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const socket = connect(Number(new URL(server.url).port), "127.0.0.1");
  let timer;
  try {
    await once(socket, "connect");
    await Promise.race([
      server.close(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Shutdown left preconnection open")), 2000); }),
    ]);
    await assert.rejects(fetch(server.url));
  } finally {
    clearTimeout(timer);
    socket.destroy();
    await app.close();
    await discardTemp(root);
  }
});
