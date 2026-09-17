import type { IncomingMessage } from "node:http";
import { maximumMediaBytes } from "./media.js";
import { saveMediaProgramsSettings } from "./media-programs.js";
import type { MediaUnderstanding } from "./media-understand.js";
import { speechEnginesApi, type SpeechEngineService } from "./speech-engine-service.js";
import type { Store } from "./store.js";

/**
 * Bucket 17: the routes behind the video card, the composer's video attachment and the speech
 * plug-ins card, in one function so src/server.ts gains a single short block.
 *
 *   GET/POST /api/media/programs     the switch, where ffmpeg and yt-dlp are, and whether they were found
 *   POST     /api/media/understand   a video or sound file (raw bytes) → still pictures and what is said
 *   GET/POST /api/voice/engines      the speech plug-ins and which one does what
 *   POST     /api/voice/command      whether a short phrase is a spoken command
 */
export interface Bucket17Deps {
  store: Store;
  owner: string;
  understanding: MediaUnderstanding;
  engines: SpeechEngineService | undefined;
}
const paths = new Set(["/api/media/programs", "/api/media/understand", "/api/voice/engines", "/api/voice/command"]);
export const handlesBucket17 = (path: string): boolean => paths.has(path);

/** A video or sound file sent as the request body, refused above the media size cap. */
export async function readMediaBody(request: IncomingMessage): Promise<{ bytes: Buffer; mediaType: string }> {
  const mediaType = (request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (!/^(video|audio)\/[a-z0-9.+-]+$/.test(mediaType)) throw new Error("Send a video or a sound file");
  if (Number(request.headers["content-length"] ?? 0) > maximumMediaBytes) throw new Error("That file is larger than 32 MB");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > maximumMediaBytes) throw new Error("That file is larger than 32 MB");
    chunks.push(Buffer.from(chunk));
  }
  if (!size) throw new Error("That file came through empty");
  return { bytes: Buffer.concat(chunks), mediaType };
}

export async function bucket17Api(
  deps: Bucket17Deps, method: string, path: string,
  body: () => Promise<unknown>, media: () => Promise<{ bytes: Buffer; mediaType: string }>,
): Promise<unknown> {
  if (path === "/api/media/programs") {
    if (method === "POST") saveMediaProgramsSettings(deps.store, deps.owner, await body());
    return deps.understanding.status(deps.owner);
  }
  if (path === "/api/media/understand" && method === "POST") {
    const upload = await media();
    const seen = await deps.understanding.understand(deps.owner, upload.bytes, upload.mediaType, AbortSignal.timeout(300_000));
    return { pictures: seen.pictures, transcript: seen.transcript, seconds: seen.seconds, notes: seen.notes };
  }
  if (path.startsWith("/api/voice/")) {
    if (!deps.engines) throw new Error("Speech plug-ins are not available in this build");
    return speechEnginesApi(deps.engines, deps.owner, method, path, body);
  }
  throw new Error("That is not something Branch can do with videos");
}
