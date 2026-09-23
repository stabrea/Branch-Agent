import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { Budget } from "../dist/contracts.js";
import { ToolRegistry } from "../dist/registry.js";
import { switchedToolTiers, videoClipTools } from "../dist/feature-switches.js";
import { saveMediaProgramsSettings, safeReaders } from "../dist/media-programs.js";
import { mediaInfo, looksLikeMp4 } from "../dist/media-video.js";
import {
  MediaClips, registerMediaClips, clipArgs, thumbnailArgs, srtFromCaptions, srtStamp, escapeFilterPath,
  thumbnailName,
} from "../dist/media-clips.js";

/**
 * FQ-packages.clips: cutting a short, playable clip with captions burned in and a thumbnail, out
 * of a video already in the workspace. Nothing here starts a real ffmpeg: the program is a function
 * that records its own argument list and writes the bytes the real one would have written, the same
 * way tests/media-understand.test.mjs stands in for it.
 */
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

/** A small, honestly-structured MP4: a header ffmpeg's real output has, and `mediaInfo` can read. */
function fakeMp4(seconds) {
  const box = (type, body) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + body.length, 0);
    header.write(type, 4, "latin1");
    return Buffer.concat([header, body]);
  };
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(600, 12); // time scale
  mvhd.writeUInt32BE(Math.round(seconds * 600), 16);
  return Buffer.concat([
    box("ftyp", Buffer.concat([Buffer.from("isom", "latin1"), Buffer.from([0, 0, 2, 0])])),
    box("moov", Buffer.concat([box("mvhd", mvhd), box("trak", Buffer.alloc(8))])),
    box("mdat", Buffer.alloc(16)),
  ]);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-clip-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}
function context(app, overrides = {}) {
  return {
    owner: "local", workspace: app.runtime.workspace, runId: "cliprun", signal: AbortSignal.timeout(20000),
    budget: new Budget(), permissions: new Set(["media.write"]), depth: 0, ...overrides,
  };
}
/** Stands in for ffmpeg: writes a valid small MP4 for the cut, a JPEG for the single-frame thumbnail. */
function fakeFfmpeg() {
  const ran = [];
  const run = async (file, args) => {
    ran.push({ file, args });
    const out = args.at(-1);
    if (args.includes("-frames:v")) await writeFile(out, jpeg);
    else await writeFile(out, fakeMp4(2));
    return "";
  };
  return { ran, run };
}
function fakeMedia(files, kept) {
  return {
    async bytesOf(path) { if (!(path in files)) throw new Error(`${path} is missing`); return files[path]; },
    savePath: (owner, name) => `media/${name}`,
    async keep(owner, name, bytes) { kept.push({ name, bytes }); return { path: `media/${name}`, bytes: bytes.length }; },
  };
}
function clips(app, media, programs) {
  return new MediaClips({ store: app.store, media, run: programs.run, find: (name) => `/usr/local/bin/${name.replace(/\.exe$/, "")}` });
}

test("the clip and thumbnail argument lists are exact, captions become an SRT file, and a path is escaped for the filtergraph", () => {
  const readers = ["-format_whitelist", safeReaders, "-protocol_whitelist", "file"];
  const withoutCaptions = clipArgs("/t/in.mp4", "/t/out.mp4", { start: 1.5, duration: 8, srt: null, width: 720 });
  assert.deepEqual(withoutCaptions, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", "1.500",
    ...readers, "-i", "/t/in.mp4", "-t", "8.000", "-vf", "scale='min(720,iw)':-2:force_original_aspect_ratio=decrease",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "/t/out.mp4"]);
  const withCaptions = clipArgs("/t/in.mp4", "/t/out.mp4", { start: 0, duration: 5, srt: "/t/captions.srt", width: 480 });
  const vf = withCaptions[withCaptions.indexOf("-vf") + 1];
  assert.match(vf, /^scale='min\(480,iw\)':-2:force_original_aspect_ratio=decrease,subtitles=/);
  assert.deepEqual(thumbnailArgs("/t/clip.mp4", "/t/thumb.jpg", 2.5, 480), ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-ss", "2.500", ...readers, "-i", "/t/clip.mp4", "-frames:v", "1", "-vf", "scale='min(480,iw)':-2", "-q:v", "4", "/t/thumb.jpg"]);

  assert.equal(srtStamp(0), "00:00:00,000");
  assert.equal(srtStamp(65.25), "00:01:05,250");
  assert.equal(srtFromCaptions([{ start: 0, end: 1.5, text: "hello" }, { start: 1.5, end: 3, text: "world" }]),
    "1\n00:00:00,000 --> 00:00:01,500\nhello\n\n2\n00:00:01,500 --> 00:00:03,000\nworld\n");

  assert.equal(escapeFilterPath("/tmp/a b/captions.srt"), "'/tmp/a b/captions.srt'");
  assert.equal(escapeFilterPath("C:\\Users\\me\\captions.srt"), "'C\\:/Users/me/captions.srt'");
  assert.equal(escapeFilterPath("/tmp/o'clock/captions.srt"), "'/tmp/o'\\''clock/captions.srt'");

  assert.equal(thumbnailName("promo.mp4"), "promo-thumbnail.jpg");
  assert.equal(thumbnailName("noext"), "noext-thumbnail.jpg");
});

test("the switch ships off: media.clip refuses in one sentence and is not advertised, then joins the group once on", async (t) => {
  const { app } = await fixture(t);
  const programs = fakeFfmpeg();
  const tool = clips(app, fakeMedia({ "in.mp4": fakeMp4(6) }, []), programs);
  await assert.rejects(tool.clip({ path: "in.mp4", start: 0, duration: 3, save: "out.mp4" }, context(app)),
    (error) => error.message.includes("switched off"));
  assert.equal(programs.ran.length, 0, "nothing was started while the switch is off");
  assert.deepEqual([...videoClipTools], ["media.clip"], "media.clip shares the video-programs switch");
  assert.deepEqual(switchedToolTiers(app.store, "local", [...videoClipTools]).hidden, ["media.clip"]);
  saveMediaProgramsSettings(app.store, "local", { mode: "on" });
  assert.equal(switchedToolTiers(app.store, "local", [...videoClipTools]).hidden.length, 0);
  assert.ok(app.registry.names().includes("media.clip"), "the app registers the tool; the switch decides whether it is offered");
});

test("a dry run says what it would clip and save without starting ffmpeg", async (t) => {
  const { app } = await fixture(t);
  saveMediaProgramsSettings(app.store, "local", { mode: "on" });
  const programs = fakeFfmpeg();
  const tool = clips(app, fakeMedia({ "in.mp4": fakeMp4(6) }, []), programs);
  const result = await tool.clip({ path: "in.mp4", start: 1, duration: 4, save: "out.mp4" }, context(app, { dryRun: true }));
  assert.equal(result.wouldSave, "media/out.mp4");
  assert.equal(result.thumbnail, "media/out-thumbnail.jpg");
  assert.equal(programs.ran.length, 0);
});

test("cutting a video's start against its own known length is refused before ffmpeg runs", async (t) => {
  const { app } = await fixture(t);
  saveMediaProgramsSettings(app.store, "local", { mode: "on" });
  const programs = fakeFfmpeg();
  const tool = clips(app, fakeMedia({ "short.mp4": fakeMp4(2) }, []), programs);
  await assert.rejects(tool.clip({ path: "short.mp4", start: 5, duration: 3, save: "out.mp4" }, context(app)),
    /only 2\.0s long/);
  assert.equal(programs.ran.length, 0);
});

test("a clip is cut with captions burned in and a thumbnail is made, both saved to the media folder", async (t) => {
  const { app } = await fixture(t);
  saveMediaProgramsSettings(app.store, "local", { mode: "on" });
  const programs = fakeFfmpeg();
  const kept = [];
  const tool = clips(app, fakeMedia({ "trip/full.mp4": fakeMp4(30) }, kept), programs);
  const captions = [{ start: 0, end: 2, text: "hello there" }, { start: 2, end: 4, text: "welcome" }];
  const result = await tool.clip({ path: "trip/full.mp4", start: 5, duration: 8, save: "promo.mp4", captions }, context(app));

  assert.equal(programs.ran.length, 2, "the clip is cut, then its thumbnail is taken");
  const [cut, thumb] = programs.ran;
  assert.equal(cut.file, "/usr/local/bin/ffmpeg");
  assert.equal(cut.args[cut.args.indexOf("-ss") + 1], "5.000");
  assert.equal(cut.args[cut.args.indexOf("-t") + 1], "8.000");
  const vf = cut.args[cut.args.indexOf("-vf") + 1];
  assert.match(vf, /^scale=.*,subtitles='.*captions\.srt'$/, "captions were asked for, so they are burned in from a real SRT file");
  assert.ok(thumb.args.includes("-frames:v"), "the second ffmpeg call takes one still picture");
  assert.equal(thumb.args[thumb.args.indexOf("-ss") + 1], "4.000", "the thumbnail is taken from the clip's midpoint");

  assert.equal(kept.length, 2);
  assert.equal(kept[0].name, "promo.mp4");
  assert.equal(kept[1].name, "promo-thumbnail.jpg");
  assert.ok(looksLikeMp4(kept[0].bytes), "the saved clip is a playable MP4");
  assert.equal(mediaInfo(kept[0].bytes).format, "mp4");
  assert.equal(kept[1].bytes.subarray(0, 2).toString("hex"), "ffd8", "the saved thumbnail is a JPEG");

  assert.equal(result.savedAs, "media/promo.mp4");
  assert.equal(result.thumbnail, "media/promo-thumbnail.jpg");
  assert.equal(result.seconds, 8);
  assert.equal(result.captions, 2);
});

test("a clip with no captions asked for is still cut and thumbnailed, with no subtitles filter", async (t) => {
  const { app } = await fixture(t);
  saveMediaProgramsSettings(app.store, "local", { mode: "on" });
  const programs = fakeFfmpeg();
  const kept = [];
  const tool = clips(app, fakeMedia({ "clip.mov": fakeMp4(10) }, kept), programs);
  const result = await tool.clip({ path: "clip.mov", start: 0, duration: 3, save: "out.mp4" }, context(app));
  const cut = programs.ran[0];
  assert.match(cut.args[cut.args.indexOf("-i") - 4], /whitelist|format_whitelist/, "the safe reader whitelist is used, not a bare -i");
  assert.equal(cut.args.includes("subtitles="), false);
  assert.ok(!cut.args[cut.args.indexOf("-vf") + 1].includes("subtitles="));
  assert.equal(result.captions, 0);
});

test("media.clip is registered with the write permission and a target the approval rules can match", async (t) => {
  const { app } = await fixture(t);
  const registry = new ToolRegistry();
  registerMediaClips(registry, clips(app, fakeMedia({}, []), fakeFfmpeg()));
  assert.ok(registry.names().includes("media.clip"));
  assert.equal(registry.permissionOf("media.clip"), "media.write");
  assert.equal(registry.targetOf("media.clip", { path: "a.mp4", save: "b.mp4" }, context(app)), "media/b.mp4");
});
