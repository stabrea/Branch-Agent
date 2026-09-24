import { rm } from "node:fs/promises";
import { createRequire } from "node:module";

/**
 * Deletes a folder and everything in it, as `rm -rf` would. Inside the desktop app, Electron reads every `.asar`
 * file as a folder of its own, so deleting one fails with EBUSY. A Dev build's `node_modules/electron/.../default_app.asar`
 * was therefore never deleted, and every later update stopped at once without a word. `original-fs` is Electron's
 * file system without that; plain Node has no such reading and uses its own.
 */
export async function removeTree(path: string): Promise<void> {
  await plainRm()(path, { recursive: true, force: true });
}

function plainRm(): typeof rm {
  if (!process.versions.electron) return rm;
  return (createRequire(import.meta.url)("original-fs") as { promises: { rm: typeof rm } }).promises.rm;
}
