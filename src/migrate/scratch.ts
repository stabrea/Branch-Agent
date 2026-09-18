import { rm } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";

/**
 * Removes a private copy made while reading another assistant's files. Windows can hold a database
 * file open for a moment after it was closed, so a busy folder is asked again a few times; a folder
 * that still will not go is left for the system's own temporary-file cleaning rather than failing
 * an import that has already succeeded.
 */
export async function discardFolder(folder: string): Promise<void> {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try { await rm(folder, { recursive: true, force: true }); return; }
    catch { await wait(50); }
  }
}
