import { z } from "zod";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import {
  AttachmentRefSchema, maxAttachmentsBytesPerTurn, maximumAttachmentsPerTurn, mediaTypeToken,
  type AttachmentInput, type AttachmentKind, type AttachmentRef,
} from "./contracts.js";
import { documentBytesLimit } from "./documents.js";

/**
 * Files a person attaches to a message: the original is kept, and the message keeps a reference to it.
 *
 * Until now the only thing that could be attached was a picture, and even that was not kept: its bytes
 * went to the model for one request and the conversation was left with "[attached picture: dot.png]".
 * A sound was turned into words and a video into a few stills, and both originals were dropped. So a
 * conversation could not show, later, what it had actually been given.
 *
 * The originals live here rather than beside what the assistant made, because a run artifact is capped
 * at 8 MB and read back only when it is a picture or a sound — neither suits a 32 MB video or a
 * document. Each conversation owns a folder; deleting the conversation deletes the folder, so a message
 * can never point at a file that is gone. A temporary conversation's folder is marked as such and swept
 * away when it closes, or at the next start if the app stopped before it could.
 */

/** The most one attachment of each kind may weigh. The page mirrors these; this is what decides. */
export const attachmentLimits: Record<AttachmentKind, number> = {
  picture: 5 * 1024 * 1024,
  sound: 25 * 1024 * 1024,
  video: 32 * 1024 * 1024,
  document: documentBytesLimit,
};
/** Written-out kinds, for a refusal a person can act on. */
const kindWords: Record<AttachmentKind, string> = {
  picture: "Pictures", sound: "Sounds", video: "Videos", document: "Documents",
};
/** The document types the Documents panel already takes; anything else is refused by name. */
const documentTypes = new Set([
  "text/plain", "text/markdown", "text/html", "text/csv", "application/json", "application/pdf",
  "application/rtf", "text/rtf", "application/epub+zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text", "application/vnd.oasis.opendocument.spreadsheet",
]);

/** Which kind a file is, by its own type; a type Branch does not take is refused by name. */
export function kindOf(mediaType: string): AttachmentKind {
  const type = mediaType.split(";")[0]!.trim().toLowerCase();
  if (type.startsWith("image/")) return "picture";
  if (type.startsWith("audio/")) return "sound";
  if (type.startsWith("video/")) return "video";
  if (documentTypes.has(type) || type.startsWith("text/")) return "document";
  throw new Error(`Branch does not take ${type} files. Pictures, sounds, videos and ordinary documents can be attached.`);
}
/** A conversation's folder name; a temporary one is marked so it can be swept away later. */
export function folderFor(sessionId: string, temporary = false): string {
  const plain = sessionId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 40);
  if (!plain) throw new Error("A conversation needs a name before a file can be attached to it");
  return temporary ? `tmp-${plain}` : plain;
}
const isTemporaryFolder = (name: string): boolean => name.startsWith("tmp-");

/**
 * The only types shown in the page itself. Everything else — documents above all, and anything that
 * could carry script such as SVG or HTML — is handed over as a download instead, so a file a person
 * was sent can never run as part of Branch's own page.
 */
const shownInPlace = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif",
  "audio/wav", "audio/mpeg", "audio/ogg", "audio/webm", "audio/mp4",
  "video/mp4", "video/webm", "video/ogg",
]);
/** Whether a kept file may be shown in the page, or has to be downloaded. */
export const shownInPage = (mediaType: string): boolean =>
  shownInPlace.has(mediaType.split(";")[0]!.trim().toLowerCase());

export interface BytesWanted { start: number; end: number }
/**
 * One range of a file, for a player that asks for part of a sound or a video. Only a single plain
 * range is understood; anything else is answered whole, and a range outside the file is refused so a
 * player is told plainly rather than handed the wrong bytes.
 */
export function rangeWanted(header: string | undefined, size: number): BytesWanted | "outside" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const [, from, to] = match;
  const start = from ? Number(from) : Math.max(0, size - Number(to));
  const end = from ? (to ? Math.min(Number(to), size - 1) : size - 1) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return "outside";
  return { start, end };
}

/** Where a path really leads, following links the way the system itself does. */
function trueName(path: string): string | null {
  try { return realpathSync.native(path); } catch { /* a link that leads nowhere, or no such file */ }
  try { return realpathSync(path); } catch { return null; }
}

/** What handing a file back needs: who is at the window, and where the files are kept. */
export interface DeliveryParts {
  profiles: { requireOwner(why: string): void };
  attachments: Pick<Attachments, "read">;
}
/**
 * Hands one kept file back for a window to show or save. The owner check is the first thing here, so
 * it moves with the operation in a refactor and holds even for a caller that found another way in.
 * The route in front of it refuses a short-lived key and a household profile as well; neither layer
 * relies on the other.
 */
export async function attachmentForWindow(
  parts: DeliveryParts, wanted: { session: string; id: string; temporary?: boolean },
): Promise<{ ref: AttachmentRef; bytes: Buffer }> {
  parts.profiles.requireOwner("Opening an attached file");
  return parts.attachments.read(wanted.session, wanted.id, { temporary: Boolean(wanted.temporary) });
}

export class Attachments {
  /**
   * The second argument exists so a test can hold the folder listing still. It is not part of the
   * app's own surface: `createBranch` builds this with one argument and gets `readdirSync`.
   */
  constructor(
    readonly root: string,
    private readonly listFolders: (path: string) => string[] = readdirSync,
  ) {}
  /** One queue per conversation, so its listing is never written by two turns at once. */
  private readonly turns = new Map<string, Promise<void>>();

  private folder(sessionId: string, temporary = false): string {
    return join(this.root, folderFor(sessionId, temporary));
  }
  private async listing(folder: string): Promise<AttachmentRef[]> {
    const text = await readFile(join(folder, "kept.json"), "utf8").catch(() => "");
    if (!text) return [];
    const read = z.array(AttachmentRefSchema).safeParse(JSON.parse(text) as unknown);
    return read.success ? read.data : [];
  }

  /** Keeps the originals and hands back what the message will carry. */
  async keep(sessionId: string, inputs: readonly AttachmentInput[], options: { temporary?: boolean } = {}): Promise<AttachmentRef[]> {
    if (!inputs.length) return [];
    if (inputs.length > maximumAttachmentsPerTurn)
      throw new Error(`Up to ${maximumAttachmentsPerTurn} files can go with one message.`);
    // Everything is checked and decoded before a single byte is written: a bad third file must not
    // leave the first two behind as bytes nothing points at.
    const ready = inputs.map((input) => this.ready(input));
    const total = ready.reduce((sum, one) => sum + one.bytes.byteLength, 0);
    if (total > maxAttachmentsBytesPerTurn)
      throw new Error(`Everything on one message can add up to ${Math.round(maxAttachmentsBytesPerTurn / 1048576)} MB; that is ${Math.round(total / 1048576)} MB.`);
    // One conversation's folder is written by one turn at a time, so two messages at once cannot each
    // write a listing that forgets the other's files.
    return this.inTurn(sessionId, options.temporary, async () => {
      const folder = this.folder(sessionId, options.temporary);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const kept = await this.listing(folder);
      const written: AttachmentRef[] = [];
      try {
        for (const one of ready) {
          await writeFile(join(folder, one.ref.id), one.bytes, { mode: 0o600 });
          written.push(one.ref);
        }
        await writeFile(join(folder, "kept.json"), JSON.stringify([...kept, ...written]), { mode: 0o600 });
      } catch (error) {
        // Nothing half-written is left lying about, even when the disk is what failed.
        for (const ref of written) await rm(join(folder, ref.id), { force: true }).catch(() => undefined);
        throw error;
      }
      return written;
    });
  }
  /** Holds one conversation's writes in a queue, so two at once cannot lose each other's files. */
  private inTurn<T>(sessionId: string, temporary: boolean | undefined, work: () => Promise<T>): Promise<T> {
    const key = folderFor(sessionId, temporary);
    const next = (this.turns.get(key) ?? Promise.resolve()).then(work, work);
    this.turns.set(key, next.then(() => undefined, () => undefined));
    return next;
  }
  /** One file checked and decoded, with nothing written yet. */
  private ready(input: AttachmentInput): { ref: AttachmentRef; bytes: Buffer } {
    // Checked here as well as at the route: this is a public way in, and a media type that is not one
    // must never reach the place where it becomes a header. Said in a sentence, not a schema dump.
    if (!mediaTypeToken.safeParse(input.mediaType).success)
      throw new Error(`${input.name} does not say what kind of file it is in a way Branch can use.`);
    const kind = kindOf(input.mediaType);
    const bytes = Buffer.from(input.data.replace(/^data:[^,]*,/, ""), "base64");
    if (!bytes.length) throw new Error(`${input.name} came through empty`);
    if (bytes.byteLength > attachmentLimits[kind])
      throw new Error(`${kindWords[kind]} up to ${Math.round(attachmentLimits[kind] / 1048576)} MB can be attached, so ${input.name} was skipped.`);
    return {
      ref: { id: randomBytes(8).toString("hex"), kind, mediaType: input.mediaType, name: input.name, bytes: bytes.byteLength },
      bytes,
    };
  }
  /**
   * One kept file, found by its conversation and its id. Nothing a caller sends is ever used as a
   * path: the id is looked up in the conversation's own listing, and the file it names is checked to
   * be really inside this store before it is opened, so a link or a name that climbs out cannot be
   * followed.
   */
  async read(sessionId: string, id: string, options: { temporary?: boolean } = {}): Promise<{ ref: AttachmentRef; bytes: Buffer }> {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new Error("That file is not attached to this conversation");
    const folder = this.folder(sessionId, options.temporary);
    const ref = (await this.listing(folder)).find((one) => one.id === id);
    if (!ref) throw new Error("That file is not attached to this conversation");
    // realpath.native, because on Windows a junction is not resolved by the plain one, and a folder
    // that is really a link to somewhere else would otherwise be followed out of the store.
    const file = trueName(join(folder, ref.id));
    const root = trueName(this.root);
    if (!file || !root || !(file === root || file.startsWith(root + sep)))
      throw new Error("That file is not attached to this conversation");
    return { ref, bytes: await readFile(file) };
  }
  /** Everything attached to one conversation, oldest first. */
  async list(sessionId: string, options: { temporary?: boolean } = {}): Promise<AttachmentRef[]> {
    return this.listing(this.folder(sessionId, options.temporary));
  }
  /** The conversation is gone, so its files go with it: nothing is left pointing at nothing. */
  async forget(sessionId: string, options: { temporary?: boolean } = {}): Promise<void> {
    await rm(this.folder(sessionId, options.temporary), { recursive: true, force: true });
  }
  /**
   * Temporary conversations leave nothing behind. Closing one sweeps its folder; this sweeps any that
   * an earlier run could not, so a stop in the wrong moment cannot turn them into permanent files.
   *
   * The names are taken **before** anything else can happen and only those are removed. A sweep that
   * outlives the app becoming ready therefore cannot delete a conversation started afterwards: that
   * folder is not on the list it is working from. Racing a timer against this would not have given
   * that promise, because the losing sweep carries on with a listing read after readiness.
   */
  async sweepTemporary(): Promise<number> {
    // Read synchronously, so the list is finished before this function first gives up the thread. An
    // asynchronous listing could resolve after the app is ready and include a folder made since.
    // Taken once, synchronously, before this function first gives up the thread: everything removed
    // afterwards comes from this list, so a folder made later cannot be on it.
    let folders: string[] = [];
    try { folders = this.listFolders(this.root); } catch { return 0; }
    const leftovers = folders.filter(isTemporaryFolder);
    let swept = 0;
    for (const name of leftovers) {
      await rm(join(this.root, name), { recursive: true, force: true }).catch(() => undefined);
      swept += 1;
    }
    return swept;
  }
}
