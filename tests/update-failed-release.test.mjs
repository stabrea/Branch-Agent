/**
 * Dogfood F1 review: with "update by itself" on, a release whose install failed (a Dev change that would not build,
 * a Beta whose check failed) is not tried again by itself every few minutes. The next release is, as soon as it
 * lands; the owner is told once; the Update button, which does not ask the plan, can always try it again.
 * Through the window's own route. Node only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t, releaseChannel) {
  const root = await mkdtemp(join(tmpdir(), "branch-update-failed-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  app.store.save("settings", app.runtime.owner, "comfort-notify", { autoUpdate: "install", releaseChannel });
  const plan = async (body) => {
    const response = await fetch(new URL("/api/comfort/update-plan", server.url), { method: "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  return { plan };
}

for (const channel of ["dev", "beta"]) {
  test(`${channel}: a release whose install failed is not tried again by itself, and the owner is told once`, async (t) => {
    const { plan } = await fixture(t, channel);
    const first = channel === "dev" ? "dev-1111111" : "v0.19.5-beta.1", next = channel === "dev" ? "dev-2222222" : "v0.19.5-beta.2";
    assert.equal((await plan({ updaterPhase: "available", updaterTag: first })).step, "install", "control: it is installed by itself");
    // Its install failed: the window says so with the updater's next status.
    const failed = await plan({ updaterPhase: "error", updaterTag: first, failedTag: first });
    assert.match(failed.failed ?? "", /will not try it again by itself/);
    assert.equal((await plan({ updaterPhase: "error", updaterTag: first, failedTag: first })).failed, undefined, "said once");
    // Five minutes on, the same release is found again: it is not installed again by itself.
    const again = await plan({ updaterPhase: "available", updaterTag: first, checked: true });
    assert.equal(again.step, "nothing");
    assert.match(again.reason, /not tried again by itself/);
    // A newer one lands: that is installed.
    assert.equal((await plan({ updaterPhase: "available", updaterTag: next })).step, "install");
  });
}
