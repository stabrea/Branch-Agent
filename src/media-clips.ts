import { readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import { mediaInfo } from "./media-video.js";
import {
  locateProgram, mediaProgramsOff, mediaProgramsSettings, safeReaders, scratchEnding,
  type MediaPrograms, type ProgramFinder, type ProgramRunner,
} from "./media-programs.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";
import { runProgram } from "./voice-stt.js";

/**
 * FQ-packages.clips: a short, playable clip cut out of a video already in the workspace, with
 * captions burned in and a thumbnail picture beside it — the one thing `media.watch`/`media.frames`
 * (src/media-understand.ts) do not do. Same owner-installed ffmpeg, same "Watching and saving
 * videos" switch and settings record, kept in its own file so it does not collide with that one.
 */

export interface ClipCaption { start: number; end: number; text: string }

const quiet = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
/** Same reader whitelist `media-programs.ts` uses: only ordinary video/sound files, never a playlist. */
const reading = (input: string): string[] =>
  ["-format_whitelist", safeReaders, "-protocol_whitelist", "file", "-i", input];

const two = (n: number): string => String(n).padStart(2, "0");
/** An SRT timestamp (`HH:MM:SS,mmm`) from a number of seconds. */
export function srtStamp(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  return `${two(h)}:${two(m)}:${two(s)},${String(ms % 1000).padStart(3, "0")}`;
}
/** Caption lines turned into an SRT file's text, the format ffmpeg's `subtitles` filter reads. */
export function srtFromCaptions(captions: ClipCaption[]): string {
  return captions.map((line, at) =>
    `${at + 1}\n${srtStamp(line.start)} --> ${srtStamp(line.end)}\n${line.text.replace(/\r\n|\r/g, "\n")}\n`).join("\n");
}
/**
 * A file path made safe to sit inside an ffmpeg filtergraph value. The filtergraph parser gives
 * meaning to `:`, `\`, `'` and `,`; backslashes become forward slashes (which ffmpeg's own file
 * reader accepts on every platform, including Windows), the drive-letter colon is escaped, and the
 * whole thing is wrapped in single quotes so a comma or space in the temp folder's name cannot be
 * read as the next filter option.
 */
export function escapeFilterPath(path: string): string {
  const forward = path.replace(/\\/g, "/");
  const escaped = forward.replace(/'/g, "'\\''").replace(/:/g, "\\:");
  return `'${escaped}'`;
}
/** The `-vf` value: scaled to fit the width asked for, with captions burned in when there are any. */
function videoFilter(width: number, srt: string | null): string {
  const scale = `scale='min(${width},iw)':-2:force_original_aspect_ratio=decrease`;
  return srt ? `${scale},subtitles=${escapeFilterPath(srt)}` : scale;
}
/** Cuts `duration` seconds starting at `start` out of `input`, captions burned in when `srt` is given. */
export function clipArgs(input: string, output: string, options: { start: number; duration: number; srt: string | null; width: number }): string[] {
  return [...quiet, "-ss", options.start.toFixed(3), ...reading(input), "-t", options.duration.toFixed(3),
    "-vf", videoFilter(options.width, options.srt), "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", output];
}
/** One still picture, `at` seconds into `input`, for a thumbnail. */
export function thumbnailArgs(input: string, output: string, at: number, width: number): string[] {
  return [...quiet, "-ss", Math.max(0, at).toFixed(3), ...reading(input), "-frames:v", "1",
    "-vf", `scale='min(${width},iw)':-2`, "-q:v", "4", output];
}
/** The clip's file name with its ending swapped for `-thumbnail.jpg`, for the picture beside it. */
export function thumbnailName(save: string): string {
  const dot = save.lastIndexOf(".");
  return `${dot > 0 ? save.slice(0, dot) : save}-thumbnail.jpg`;
}

/* ---------- the tool ---------- */

/** What `media.clip` needs of the shared media tools: a slice, not the whole class, so a test can stand one in. */
export interface ClipMediaTools {
  bytesOf(path: string): Promise<Buffer>;
  savePath(owner: string, name: string): string;
  keep(owner: string, name: string, bytes: Buffer): Promise<{ path: string; bytes: number }>;
}
export interface MediaClipsDeps {
  store: Store;
  media: ClipMediaTools;
  run?: ProgramRunner;
  find?: ProgramFinder;
  platform?: NodeJS.Platform;
}
export interface ClipInput {
  path: string;
  start: number;
  duration: number;
  save: string;
  captions?: ClipCaption[] | undefined;
  width?: number | undefined;
}

export class MediaClips {
  private readonly run: ProgramRunner;
  constructor(private readonly deps: MediaClipsDeps) {
    this.run = deps.run ?? runProgram;
  }
  private settings(owner: string): MediaPrograms {
    const settings = mediaProgramsSettings(this.deps.store, owner);
    if (settings.mode === "off") throw new Error(mediaProgramsOff);
    return settings;
  }
  private locate(settings: MediaPrograms): Promise<string> {
    return locateProgram("ffmpeg", settings, this.deps.find, this.deps.platform);
  }
  /** Where the clip (or its thumbnail) would land, so approval rules match on the real path. */
  savePath(owner: string, name: string): string {
    return this.deps.media.savePath(owner, name);
  }
  private async scratch<T>(work: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "branch-clip-"));
    try { return await work(dir); } finally { await rm(dir, { recursive: true, force: true }); }
  }
  /** The `media.clip` tool: a short clip, captions burned in, and a thumbnail, saved to the media folder. */
  async clip(input: ClipInput, context: ToolContext): Promise<Record<string, unknown>> {
    const settings = this.settings(context.owner);
    const thumbSave = thumbnailName(input.save);
    if (context.dryRun)
      return {
        wouldClip: input.path, from: input.start, seconds: input.duration,
        wouldSave: this.savePath(context.owner, input.save), thumbnail: this.savePath(context.owner, thumbSave),
      };
    const ffmpeg = await this.locate(settings);
    const bytes = await this.deps.media.bytesOf(input.path);
    let total: number | null = null;
    try { total = mediaInfo(bytes).seconds; } catch { /* headers do not say; take the owner's word for the start */ }
    if (total !== null && input.start >= total)
      throw new Error(`${input.path} is only ${total.toFixed(1)}s long, so a clip cannot start at ${input.start}s`);
    const width = input.width ?? 720;
    return this.scratch(async (dir) => {
      const source = join(dir, `input${scratchEnding(input.path)}`);
      await writeFile(source, bytes, { mode: 0o600 });
      let srt: string | null = null;
      if (input.captions?.length) {
        srt = join(dir, "captions.srt");
        await writeFile(srt, srtFromCaptions(input.captions), "utf8");
      }
      const clipOut = join(dir, "clip.mp4");
      await this.run(ffmpeg, clipArgs(source, clipOut, { start: input.start, duration: input.duration, srt, width }), context.signal);
      const clipBytes = await readFile(clipOut);
      const savedClip = await this.deps.media.keep(context.owner, input.save, clipBytes);
      const thumbOut = join(dir, "thumbnail.jpg");
      const midpoint = Math.min(input.duration / 2, Math.max(input.duration - 0.1, 0));
      await this.run(ffmpeg, thumbnailArgs(clipOut, thumbOut, midpoint, width), context.signal);
      const savedThumb = await this.deps.media.keep(context.owner, thumbSave, await readFile(thumbOut));
      return {
        path: input.path, savedAs: savedClip.path, bytes: savedClip.bytes,
        thumbnail: savedThumb.path, seconds: input.duration, captions: input.captions?.length ?? 0,
      };
    });
  }
}

const pathSchema = z.string().min(1).max(500);
const nameSchema = z.string().trim().max(100).regex(/^[a-z0-9][a-z0-9._-]*\.mp4$/i, "Save under a simple name ending in .mp4");
const captionSchema = z.object({
  start: z.number().min(0).max(3600),
  end: z.number().min(0).max(3600),
  text: z.string().trim().min(1).max(200),
}).strict();
/** The `media.clip` tool, gated by the same "Watching and saving videos" switch as `mediaProgramTools`. */
export const clipTools = ["media.clip"] as const;
export function registerMediaClips(registry: ToolRegistry, clips: MediaClips): void {
  registry.register({
    name: "media.clip", permission: "media.write",
    description: "Cut a short, playable clip out of a video in the workspace, burn in captions if given, and save the clip and a thumbnail picture into the media folder.",
    parameters: z.object({
      path: pathSchema,
      start: z.number().min(0).max(36000).default(0),
      duration: z.number().gt(0).max(90).default(15),
      save: nameSchema,
      captions: z.array(captionSchema).max(200).optional(),
      width: z.number().int().min(120).max(1920).default(720),
    }).strict(),
    target: (input, context) => clips.savePath(context.owner, input.save),
    execute: (input, context) => clips.clip(input, context),
  });
}
