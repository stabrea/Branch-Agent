import { readWav } from "./media-audio.js";

/**
 * How long a piece of spoken audio actually runs, read from the sound itself rather than trusted
 * from whichever route produced it. Closes the gap where the reading-aloud tool and the
 * `/api/voice/speak` route always reported no length at all: now the computer's own voice and any
 * other route that hands back real WAV sound have their real length opened and reported.
 *
 * Only WAV audio can be measured this way without a decoder this app does not ship, so a squeezed
 * format such as an OpenAI MP3 reply is left alone rather than guessed at. Bytes that only look
 * like a WAV file — too short, missing a chunk, corrupt — come back as no duration at all rather
 * than a wrong one; this is what actually opens the file instead of counting its bytes.
 */
export function spokenDurationSeconds(bytes: Uint8Array, mediaType: string): number | null {
  if (!mediaType.toLowerCase().includes("wav")) return null;
  try {
    const sound = readWav(Buffer.from(bytes));
    return Math.round(sound.seconds * 100) / 100;
  } catch {
    return null;
  }
}
