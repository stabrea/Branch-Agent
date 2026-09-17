import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { errorText } from "./contracts.js";
import { SqliteVectors, type VectorBackend } from "./vector-store.js";

/**
 * Somewhere else to keep the lists of numbers: a database file of your own choosing, anywhere on
 * this computer, instead of inside the one Branch keeps everything else in.
 *
 * This is the whole of the second place, and it is deliberately not a connector to a hosted vector
 * service. Nobody running Branch on their own computer is running Qdrant or Chroma beside it, an
 * adapter for one could not be tested here without a network, and adding a dependency to talk to a
 * service you do not have is a worse answer than saying so. What there is instead is the
 * `VectorBackend` contract, one real second implementation of it that you can switch on today, and
 * a worked example in `docs/configuration.md` of how to write a third against anything you like.
 *
 * Why anyone would want this. A large personal library's vectors can be bigger than everything else
 * Branch stores put together; putting them on another drive keeps the main database small and quick
 * to copy, and keeps them out of the whole-application backup, which never carried them anyway
 * because a button rebuilds them.
 *
 * Two promises. When the file cannot be opened Branch says so in one sentence and carries on with
 * its own database — it never starts up broken and it never fails a search silently. And nothing is
 * ever deleted by switching: the vectors you already had stay where they were, and the new place
 * fills up the next time you press **Read it again**.
 */
export const VectorStoreSettingsSchema = z.object({
  /** `database` is the one Branch already keeps; `file` is one you name. */
  vectorsIn: z.enum(["database", "file"]).default("database"),
  /** The full path of that file, such as `D:/branch/vectors.db`. Only read when `vectorsIn` is `file`. */
  vectorsFile: z.string().trim().max(400).default(""),
}).strict();
export type VectorStoreSettings = z.infer<typeof VectorStoreSettingsSchema>;

/** What a knowledge base shows when the vectors are somewhere the owner chose. */
export const fileBackendName = (path: string): string => `a database file you chose (${path})`;

/**
 * The backend for one file, or the sentence saying why not. A folder that is not there is made,
 * because asking somebody to create an empty folder by hand before a setting will take is a poor
 * way to treat them; a path that cannot be written to is refused rather than guessed at.
 */
export function openVectorFile(path: string): { backend: VectorBackend } | { refusal: string } {
  const wanted = path.trim();
  if (!wanted) return { refusal: "No file was named for your vectors, so Branch is using its own database." };
  if (!isAbsolute(wanted))
    return { refusal: `"${wanted}" is not a full path, so Branch cannot tell where you meant. Give the whole path, such as D:/branch/vectors.db. Branch is using its own database instead.` };
  try {
    const folder = dirname(wanted);
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
    const backend = new SqliteVectors(new DatabaseSync(wanted), fileBackendName(wanted), true);
    // Proves it can actually be written to now rather than at the end of a long reading.
    backend.countNow("", "");
    return { backend };
  } catch (error) {
    return { refusal: cannotOpen(wanted, errorText(error)) };
  }
}

/** The sentence a person reads when the file they chose is not reachable. */
export const cannotOpen = (path: string, reason: string): string =>
  `Branch could not open ${path}, the file you chose for your vectors: ${reason.slice(0, 160)}. `
  + "It is using its own database instead. Nothing you have already read has been lost, and nothing "
  + "was written to that file.";

/**
 * Where this owner's vectors should go, and the note the Documents panel shows. Called once when
 * the app starts, so a wrong setting is one sentence on the panel rather than a failure per search.
 */
export function chooseVectorStore(
  settings: VectorStoreSettings, shipped: VectorBackend,
): { backend: VectorBackend; note: string } {
  if (settings.vectorsIn !== "file") return { backend: shipped, note: "" };
  const opened = openVectorFile(settings.vectorsFile);
  return "backend" in opened
    ? { backend: opened.backend, note: "" }
    : { backend: shipped, note: opened.refusal };
}
