import { z } from "zod";
import { findOnPath } from "./voice-tts.js";
import { FeatureModeSchema, type FeatureMode } from "./feature-switches.js";
import { lockdownOverrides } from "./lockdown.js";
import type { Store } from "./store.js";
import { voiceSettings, type VoiceSettings } from "./voice.js";

/**
 * mac7/wake-pins: a word that starts a turn without the Talk button.
 *
 * Three things are true of it and are checked by the tests rather than promised here:
 *
 *   • Listening happens on this computer only. The word is spotted by something already on this
 *     machine, and no sound ever leaves it. When this computer has nothing that can spot a word on
 *     its own, the switch stays off and the card says so, rather than sending sound to a service.
 *   • Nothing is recorded before the word is heard. What the listener holds is a few seconds of
 *     sound in memory, thrown away every time the word is not there. No file is written, and
 *     nothing is kept, until the word has been heard.
 *   • The word opens an ordinary spoken turn. It grants nothing: whatever is said after it is asked
 *     about exactly as the same words typed into the box would be.
 *
 * Holding the Talk button (R17-S18) stays the way in. This ships off, like every other feature.
 */
export const wakeWordKey = "wake-word";

export const WakeWordSettingsSchema = z.object({
  /** off — nothing listens at all; when needed — only while a conversation is open; on — whenever Branch is running. */
  mode: FeatureModeSchema.default("off"),
  /** The owner's own word or short phrase. Empty means there is nothing to listen for. */
  word: z.string().trim().max(40).default(""),
  /** How sure the spotter must be, out of a hundred. Lower hears the word more often, and more often wrongly. */
  sureness: z.number().int().min(50).max(99).default(80),
  /**
   * The longest piece of sound the listener will hold at once, in seconds. A piece longer than this
   * is dropped without being looked at, so however the sound arrives, no more than this is ever in
   * memory, and it is thrown away again whether the word was in it or not.
   */
  windowSeconds: z.number().int().min(1).max(5).default(2),
}).strict();
export type WakeWordSettings = z.infer<typeof WakeWordSettingsSchema>;

/** The saved settings, with Lockdown winning over a saved mode exactly as every other switch does. */
export function wakeWordSettings(store: Pick<Store, "get">, owner: string): WakeWordSettings {
  const saved = WakeWordSettingsSchema.safeParse(store.get("settings", owner, wakeWordKey)?.data ?? {});
  const settings = saved.success ? saved.data : WakeWordSettingsSchema.parse({});
  return lockdownOverrides(store, owner, wakeWordKey) ? { ...settings, mode: "off" } : settings;
}

export function saveWakeWordSettings(store: Store, owner: string, input: unknown): WakeWordSettings {
  const given = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const next = WakeWordSettingsSchema.parse({ ...wakeWordSettings(store, owner), ...given });
  store.save("settings", owner, wakeWordKey, next);
  return next;
}

/* ---------- what each computer can really do ---------- */

/** A program run for the spotter. Always passed in, so a test hands in a fake and no microphone is opened. */
export type WakeRunner = (
  file: string, args: readonly string[], input: Uint8Array, env: Readonly<Record<string, string>>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface WakeSpotter {
  /** True when this computer can spot a word on its own. */
  available: boolean;
  /**
   * Which spotter this is. Windows' own engine can open the microphone for itself; a speech program
   * the owner set up is handed sound by something else. The capture below turns on that difference.
   */
  kind: "windows-speech" | "own-program" | "none";
  /** What it would use, or why it cannot, in the owner's words. */
  how: string;
  /**
   * The program, its arguments and the whole of the environment it is given, or null when there is
   * nothing to run. The environment is built here and holds only these two names: the spotter never
   * inherits this computer's own environment, so nothing of the owner's can leak into it, and the
   * word travels as its own thing rather than as text inside a command (integration review).
   */
  command: { file: string; args: string[]; env: Record<string, string> } | null;
}

const windowsSpotter = (word: string, sureness: number, ownMicrophone: boolean, windowSeconds: number): WakeSpotter => ({
  available: true,
  kind: "windows-speech",
  how: ownMicrophone
    ? "Windows' own speech recognition, which runs on this computer, opens the microphone itself and needs nothing installed."
    : "Windows' own speech recognition, which runs on this computer and needs nothing installed.",
  command: {
    file: "powershell.exe",
    // The word is never put into the script text. PowerShell's -Command takes one string and glues
    // any words after it onto the end of that same string, so an argument there would be read as
    // PowerShell after all; the word is handed over in the environment instead, where it is only
    // ever a value (integration review, mac7/wake-pins).
    args: ["-NoProfile", "-NonInteractive", "-Command", ownMicrophone ? windowsListeningScript : windowsScript],
    env: ownMicrophone
      ? { ...wakeEnvironment(word, sureness), BRANCH_WAKE_WINDOW: String(windowSeconds) }
      : wakeEnvironment(word, sureness),
  },
});

/**
 * The whole environment the spotter is given: the word, how sure it must be, and nothing else. Built
 * rather than inherited, so neither this computer's environment nor anything in it reaches the
 * spotter, and the word is a value the program reads rather than text in a command line.
 */
const wakeEnvironment = (word: string, sureness: number): Record<string, string> =>
  ({ BRANCH_WAKE_WORD: word, BRANCH_WAKE_SURENESS: String(sureness / 100) });

/**
 * The one-word grammar, on this computer. System.Speech ships with Windows, recognises against a
 * grammar of exactly one phrase, and never reaches the network; the online Windows dictation
 * service is a different class and is not used.
 */
const windowsGrammar = [
  "$Word = $env:BRANCH_WAKE_WORD",
  "$Sureness = [double]$env:BRANCH_WAKE_SURENESS",
  "Add-Type -AssemblyName System.Speech",
  "$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine",
  "$choices = New-Object System.Speech.Recognition.Choices($Word)",
  "$builder = New-Object System.Speech.Recognition.GrammarBuilder($choices)",
  "$engine.LoadGrammar((New-Object System.Speech.Recognition.Grammar($builder)))",
];
const windowsAnswer = "if ($heard -and $heard.Confidence -ge $Sureness) { Write-Output $heard.Text }";

/** Sound handed in on standard input: what mac7/wake-pins wrote, unchanged. */
const windowsScript = [
  ...windowsGrammar,
  "$engine.SetInputToWaveStream([Console]::OpenStandardInput())",
  "$heard = $engine.Recognize()",
  windowsAnswer,
].join("; ");

/**
 * mac7/wake-mic: the same engine opening the microphone itself, for one window and no longer. The
 * window is a number the owner chose between one and five, and it travels in the environment beside
 * the word rather than being pasted into the script, exactly as the word does.
 *
 * One run is one window: the program ends when the window is up, which is what lets go of the
 * microphone. Nothing is written down, and no sound ever reaches Branch at all on this path.
 */
const windowsListeningScript = [
  ...windowsGrammar,
  "$engine.SetInputToDefaultAudioDevice()",
  "$heard = $engine.Recognize([TimeSpan]::FromSeconds([double]$env:BRANCH_WAKE_WINDOW))",
  windowsAnswer,
].join("; ");

const ownSpeechProgram = (settings: VoiceSettings, word: string): WakeSpotter => ({
  available: true,
  kind: "own-program",
  // The word itself is never put in this sentence: the sentence is shown to whoever is using this
  // computer, and the owner's word is theirs alone (integration review, mac7/wake-pins).
  how: `The speech program you already set up on this computer (${settings.localSpeechKind}), asked only whether it heard your word. It writes out what it heard rather than saying how sure it is, so "how sure it must be" does nothing while this is what spots the word.`,
  command: {
    file: settings.localSpeechExecutable,
    args: settings.localSpeechKind === "whisper-cpp"
      ? ["-m", settings.localSpeechModel, "-f", "-", "-otxt", "-nt"]
      : ["--model", settings.localSpeechModel, "--output_format", "txt", "-"],
    env: wakeEnvironment(word, 0),
  },
});

const nothingHere = (platform: string): WakeSpotter => ({
  available: false,
  kind: "none",
  how: platform === "darwin"
    ? "This Mac has nothing that spots a word on its own: macOS keeps its speech recognition inside apps with a window, and there is no command here that can be asked. Set up a speech program on this computer under Voice and the wake word can use that; until then it stays off, because the only other way would be sending what your microphone hears to a service, which is never done."
    : "This computer has nothing that spots a word on its own: Linux ships no speech recognition. Set up a speech program on this computer under Voice and the wake word can use that; until then it stays off, because the only other way would be sending what your microphone hears to a service, which is never done.",
  command: null,
});

/**
 * What this computer would really use to spot the word. Windows has a word-spotter of its own;
 * macOS and Linux have none that a program can ask, so they use a speech program the owner has
 * already set up, and say plainly that there is nothing otherwise.
 */
export function wakeSpotter(
  settings: VoiceSettings, wake: WakeWordSettings, platform: string = process.platform,
  /** True when this spotter is the one opening the microphone, rather than being handed sound. */
  ownMicrophone = false,
): WakeSpotter {
  if (!wake.word) return { available: false, kind: "none", how: "No word has been chosen yet.", command: null };
  // mac7/wake-mic: when this spotter is the one opening the microphone, Windows' own engine is the
  // only thing here that can, whatever speech program the owner has set up for writing out
  // recordings — Windows ships no recorder to feed one.
  if (ownMicrophone && platform === "win32") return windowsSpotter(wake.word, wake.sureness, true, wake.windowSeconds);
  if (settings.localSpeechExecutable && settings.localSpeechModel) return ownSpeechProgram(settings, wake.word);
  if (platform === "win32") return windowsSpotter(wake.word, wake.sureness, ownMicrophone, wake.windowSeconds);
  return nothingHere(platform);
}

/* ---------- what opens the microphone, on each computer ---------- */

/**
 * Whether a program is on this computer, asked without running it. Always passed in, so a test
 * decides the answer and the result never depends on what happens to be installed on the machine
 * running the tests.
 */
export type ProgramPresent = (name: string) => boolean;

/**
 * How the sound gets in.
 *
 *   • "recorder" — a recorder this system ships is run for one window and then ends.
 *   • "spotter-listens" — the spotter opens the microphone itself, so Branch never holds any sound.
 *   • "none" — nothing here can listen, and the switch stays off.
 */
export type WakeCaptureKind = "recorder" | "spotter-listens" | "none";

export interface WakeCapture {
  kind: WakeCaptureKind;
  /** True when this computer can listen at all. */
  available: boolean;
  /** What it would use, or why it cannot, in the owner's words. */
  how: string;
  /** The recorder and its arguments, or null when nothing is run to record. */
  command: { file: string; args: string[] } | null;
}

/** Sixteen thousand samples a second, two bytes each, one channel: what every recorder below is asked for. */
export const wakeSampleRate = 16000;
/** The most bytes one window may ever be, so a recorder that will not stop is stopped by the count. */
export const windowBytes = (windowSeconds: number): number => wakeSampleRate * 2 * windowSeconds + 4096;

const alsaRecorder = (windowSeconds: number): WakeCapture["command"] => ({
  file: "arecord",
  // `-d` ends it on its own after the window; the count of bytes ends it too, so a recorder that
  // ignores the flag still cannot hold more than one window.
  args: ["-q", "-f", "S16_LE", "-r", String(wakeSampleRate), "-c", "1", "-t", "wav", "-d", String(windowSeconds), "-"],
});

// parecord has no length of its own, so this one is ended by the count of bytes alone rather than
// by a flag guessed at. Writing to "-" is standard output; no file name is ever an argument.
const pulseRecorder = (): WakeCapture["command"] => ({
  file: "parecord",
  args: ["--file-format=wav", `--rate=${wakeSampleRate}`, "--channels=1", "--format=s16le", "-"],
});

/**
 * mac7/wake-mac: sox, which the owner installed themselves. `rec` is sox with the microphone
 * already chosen; where only `sox` is here, `-d` is what chooses it, and the two are otherwise the
 * same command. `trim 0 <window>` ends it after one window, and the count of bytes ends it too, so
 * a build that ignored the effect still could not hold more than the owner allowed.
 */
const soxRecorder = (file: string, windowSeconds: number): WakeCapture["command"] => ({
  file,
  // Writing to "-" is standard output; no file name is ever an argument, and the word never is.
  args: [
    ...(file === "sox" ? ["-d"] : []),
    "-q", "-c", "1", "-r", String(wakeSampleRate), "-b", "16", "-e", "signed-integer", "-t", "wav", "-",
    "trim", "0", String(windowSeconds),
  ],
});

/**
 * mac7/wake-mac: ffmpeg, also the owner's own, for a Mac that has it and not sox. One window from
 * the microphone macOS calls the default one, straight to standard output and no further.
 */
const ffmpegRecorder = (windowSeconds: number): WakeCapture["command"] => ({
  file: "ffmpeg",
  args: [
    "-hide_banner", "-loglevel", "quiet", "-nostdin", "-f", "avfoundation", "-i", ":default",
    "-t", String(windowSeconds), "-ac", "1", "-ar", String(wakeSampleRate), "-c:a", "pcm_s16le", "-f", "wav", "-",
  ],
});

/** The recording programs a Mac is looked at for, best first. None is ever installed or bundled. */
const macRecorders = ["rec", "sox", "ffmpeg"] as const;

/**
 * mac7/wake-mac: what would open the microphone on a Mac. macOS ships no recorder a program can
 * ask, so Branch looks for one the owner already installed and runs nothing otherwise — it installs
 * nothing, bundles nothing, and a Mac with none says which one to install and stays off.
 *
 * The sentence names the program it found, because macOS itself is about to ask the owner whether
 * Branch may open the microphone and they should know what would be asking before they say yes.
 */
function macRecorder(present: ProgramPresent, windowSeconds: number): WakeCapture {
  const file = macRecorders.find((name) => present(name));
  if (!file)
    return cannotListen("This Mac has no recording program on it: macOS ships no recorder a program can ask for sound, and Branch will not install one of its own to open your microphone. Install one yourself — `brew install sox` is the smallest — and the wake word can use it; until then the switch stays off.");
  return {
    kind: "recorder", available: true,
    command: file === "ffmpeg" ? ffmpegRecorder(windowSeconds) : soxRecorder(file, windowSeconds),
    how: `${file}, which you installed on this computer yourself, run for one window of sound at a time and then ended, so the microphone is let go of every window. The first time it runs, macOS itself will ask whether Branch may use your microphone: that question comes from macOS, it is yours to accept or refuse, and Branch cannot answer it for you — until you do, nothing is heard.`,
  };
}

const cannotListen = (how: string): WakeCapture => ({ kind: "none", available: false, how, command: null });

/**
 * What would really open the microphone here. Each system is asked about what it ships, never told:
 * Linux is looked up on the search path, and neither recorder is assumed to be there.
 */
export function wakeCapture(
  platform: string, present: ProgramPresent, spotter: WakeSpotter, windowSeconds: number,
): WakeCapture {
  // mac7/wake-mac: a Mac is looked at before the spotter, so the card can say which recording
  // program is here, or which to install, even while there is nothing to spot the word with yet.
  if (platform === "darwin") return macRecorder(present, windowSeconds);
  if (!spotter.command)
    return cannotListen("Nothing here can spot the word, so there is nothing to listen with either.");
  if (spotter.kind === "windows-speech")
    return { kind: "spotter-listens", available: true, command: null,
      how: "Windows' own speech recognition opens the microphone itself, for one window at a time, and no sound ever reaches Branch." };
  if (platform === "linux") {
    const recorder = present("arecord") ? alsaRecorder(windowSeconds) : present("parecord") ? pulseRecorder() : null;
    return recorder
      ? { kind: "recorder", available: true, command: recorder,
          how: `${recorder.file}, which is already on this computer, run for one window of sound at a time and then ended.` }
      : cannotListen("This computer has no recorder a program can ask: neither arecord nor parecord is here. Install one of them yourself and the wake word can use it; until then it stays off, because Branch will not add a program of its own to open your microphone.");
  }
  return cannotListen("This computer has no recorder a program can ask, so nothing can be listened for. The switch stays off.");
}

/* ---------- starting, and every reason not to ---------- */

/** The real answer on this computer: a look at the search path, which starts nothing. */
export const onThisComputer: ProgramPresent = (name) => findOnPath(name) !== null;

/**
 * The settings, the spotter and the capture, worked out together and in that order. A spotter that
 * opens the microphone itself is asked for a second time once the capture has said so, which is the
 * only thing that changes about it; nothing here runs anything.
 */
export function wakeParts(
  store: Store, owner: string, platform: string = process.platform, present: ProgramPresent = onThisComputer,
): { wake: WakeWordSettings; spotter: WakeSpotter; capture: WakeCapture } {
  const wake = wakeWordSettings(store, owner);
  const voice = voiceSettings(store, owner);
  const handedSound = wakeSpotter(voice, wake, platform);
  const recorded = wakeCapture(platform, present, handedSound, wake.windowSeconds);
  // The spotter that opens the microphone is a different program from the one that is handed sound,
  // so it is asked for once the capture has said which this is. Windows has nothing to record with,
  // so its own engine is also what listens there when the owner has set up a speech program of
  // their own: that program could spot the word, but nothing on Windows could feed it.
  const listensItself = recorded.kind === "spotter-listens" || (!recorded.available && platform === "win32");
  if (!listensItself) return { wake, spotter: handedSound, capture: recorded };
  const spotter = wakeSpotter(voice, wake, platform, true);
  return { wake, spotter, capture: wakeCapture(platform, present, spotter, wake.windowSeconds) };
}

/** Why listening for the word is refused right now, or null. Every sentence is one the owner reads. */
export function wakeRefusal(
  store: Store, owner: string, platform: string = process.platform, present: ProgramPresent = onThisComputer,
): string | null {
  const wake = wakeWordSettings(store, owner);
  if (wake.mode === "off")
    return lockdownOverrides(store, owner, wakeWordKey)
      ? "Lockdown is on, so nothing is listening for your word. Turn Lockdown off in Settings to allow this again."
      : "The wake word is switched off, so nothing is listening. Turn it on in Settings, Voice.";
  if (!wake.word) return "No word has been chosen yet, so there is nothing to listen for. Choose one in Settings, Voice.";
  // mac7/wake-mic: "when needed" means "only while a conversation is open on the screen", and
  // nothing tells this listener that. Rather than listen all the time under a switch that promises
  // otherwise, it says so and holds nothing open.
  if (wake.mode === "when-needed")
    return "\"When needed\" is not wired up yet: nothing tells the listener whether a conversation is open on the screen, so it would end up listening all the time, which is not what that setting says. Choose On, or leave it Off, in Settings, Voice.";
  const { spotter, capture } = wakeParts(store, owner, platform, present);
  if (!spotter.available) return spotter.how;
  // mac7/wake-mic: spotting the word is not listening for it. A computer with no way to record is
  // refused here, after the spotter, so the sentence the owner reads names the real reason.
  if (!capture.available) return capture.how;
  return null;
}

/** What this computer would really use to hear the word at all: the recorder, or the spotter itself. */
export function wakeCaptureFor(
  store: Store, owner: string, platform: string = process.platform, present: ProgramPresent = onThisComputer,
): WakeCapture {
  return wakeParts(store, owner, platform, present).capture;
}

/** What the card shows: the switch, the word, and what this computer would really do. */
export function wakeWordState(
  store: Store, owner: string, platform: string = process.platform,
  /** Whether the listener is running this moment. Read from the listener itself, never guessed from the switch. */
  listening = false, present: ProgramPresent = onThisComputer,
): {
  settings: WakeWordSettings; spotter: WakeSpotter; capture: WakeCapture; refusal: string | null;
  mode: FeatureMode; listening: boolean; canListen: boolean;
} {
  const { wake: settings, spotter, capture } = wakeParts(store, owner, platform, present);
  return {
    settings, mode: settings.mode, spotter, capture,
    refusal: wakeRefusal(store, owner, platform, present),
    /** Whether this computer can listen for a word at all, whatever the switch says. */
    canListen: spotter.available && capture.available,
    listening,
  };
}

/**
 * The same, as it goes over the wire. The program that would be run never travels: its full path is
 * a thing of the owner's, and the card only ever shows the sentence and whether there is a spotter
 * at all. What is left is the switch, the word, that sentence, and why it is refused right now.
 */
export function wakeWordView(
  store: Store, owner: string, platform: string = process.platform, isOwner = true,
  listening = false, present: ProgramPresent = onThisComputer,
): {
  settings: Omit<WakeWordSettings, "word"> & { word?: string }; spotter: { available: boolean; how: string };
  capture: { available: boolean; how: string }; refusal: string | null; mode: FeatureMode;
  listening: boolean; canListen: boolean; wordChosen: boolean;
} {
  const state = wakeWordState(store, owner, platform, listening, present);
  const { word, ...rest } = state.settings;
  return {
    ...state,
    // The word is the owner's own. Somebody else on this computer is told whether one has been
    // chosen — which is why nothing is listening — and never what it is (integration review).
    settings: isOwner ? state.settings : rest,
    wordChosen: word.length > 0,
    spotter: { available: state.spotter.available, how: state.spotter.how },
    // The recorder's own name is a thing of this computer's; the sentence is what the card shows.
    capture: { available: state.capture.available, how: state.capture.how },
  };
}

/* ---------- the listener ---------- */

export interface WakeHeard {
  heard: boolean;
  /** What the spotter wrote out, kept only long enough to compare it with the word. */
  text: string;
}

/** Whether what the spotter wrote out is the owner's word. Case and punctuation are ignored. */
export function isTheWord(text: string, word: string): boolean {
  const plain = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").replace(/\s+/g, " ").trim();
  const said = plain(text), wanted = plain(word);
  return wanted.length > 0 && said.includes(wanted);
}

/**
 * Asks the spotter about one window of sound. The runner is a parameter, so every test hands in a
 * fake and no microphone is ever opened; nothing here writes a file, and the sound is handed to the
 * program on its standard input rather than being put anywhere on disk.
 */
export async function askSpotter(runner: WakeRunner, spotter: WakeSpotter, word: string, sound: Uint8Array): Promise<WakeHeard> {
  if (!spotter.command) return { heard: false, text: "" };
  const done = await runner(spotter.command.file, spotter.command.args, sound, spotter.command.env);
  const text = done.code === 0 ? done.stdout.trim().slice(0, 200) : "";
  return { heard: isTheWord(text, word), text };
}

/** A window of sound, and how many seconds of it there are. */
export interface WakeChunk { sound: Uint8Array; seconds: number }

export interface WakeListenerDeps {
  store: Store;
  owner: string;
  runner: WakeRunner;
  platform?: string;
  present?: ProgramPresent;
}

/**
 * Listens for the word over a stream of sound the caller provides. The stream is a parameter as
 * well: nothing in this file opens a microphone, and the sound it is handed is held in memory for
 * at most the window the owner chose and dropped the moment the word is not in it.
 *
 * It answers the first time the word is heard, and stops; what happens next is an ordinary spoken
 * turn with the same permissions and the same questions as a typed one.
 */
export async function listenForWake(
  deps: WakeListenerDeps, sound: AsyncIterable<WakeChunk>,
): Promise<{ heard: boolean; text: string; refusal: string | null; windowsTried: number; windowsTooLong: number }> {
  const platform = deps.platform ?? process.platform;
  const present = deps.present ?? onThisComputer;
  const refusal = wakeRefusal(deps.store, deps.owner, platform, present);
  if (refusal) return { heard: false, text: "", refusal, windowsTried: 0, windowsTooLong: 0 };
  let windowsTried = 0, windowsTooLong = 0;
  /** The only copy of any sound this function ever holds; replaced, never added to, never written. */
  let held: Uint8Array | null = null;
  for await (const chunk of sound) {
    // mac7/wake-mic: asked again before every window rather than once at the start. Lockdown coming
    // on, or the switch going off, stops the listener within one window whoever turned it — the app,
    // the command line, or another window — and the microphone is let go of with it.
    const stop = wakeRefusal(deps.store, deps.owner, platform, present);
    if (stop) return { heard: false, text: "", refusal: stop, windowsTried, windowsTooLong };
    const { wake, spotter } = wakeParts(deps.store, deps.owner, platform, present);
    // More than the owner allowed to be held at once is dropped where it arrives, without being
    // looked at, so the promise on the card is kept however the sound is handed over.
    if (chunk.seconds > wake.windowSeconds) { windowsTooLong += 1; continue; }
    held = chunk.sound;
    windowsTried += 1;
    const answer = await askSpotter(deps.runner, spotter, wake.word, held);
    held = null; // thrown away before the next window, heard or not
    if (answer.heard) return { heard: true, text: answer.text, refusal: null, windowsTried, windowsTooLong };
  }
  return { heard: false, text: "", refusal: null, windowsTried, windowsTooLong };
}

/* ---------- mac7/wake-mic: the listener the app owns ---------- */

/**
 * Records one window of sound and hands it back. Always a parameter, so every test hands in a fake
 * and no microphone is opened; the real one is in src/voice-wake-host.ts, and it keeps nothing.
 */
export type WakeCaptureRunner = (
  command: { file: string; args: readonly string[] }, windowSeconds: number, signal: AbortSignal,
) => Promise<Uint8Array>;

export interface WakeWordListener {
  /** Whether the listener is running this moment. The card reads this rather than guessing. */
  readonly listening: boolean;
  /** Start or stop, according to what the settings now say. Called whenever one of them changes. */
  refresh(): void;
  /** Stop listening and let go of the microphone. */
  stop(): Promise<void>;
}

export interface WakeWordDeps extends WakeListenerDeps {
  capture: WakeCaptureRunner;
  /**
   * What the spotter wrote out, once the word was in it. The caller starts an ordinary turn with
   * it — the same one a typed message starts, with the same permissions and the same questions.
   * Hearing the word grants nothing.
   */
  onHeard: (text: string) => void | Promise<void>;
}

/**
 * One window of sound at a time, for as long as the listener runs. Each window is recorded by a
 * program that ends when the window is up, so the microphone is held for the window and no longer,
 * and only one window is ever in memory. Where the spotter opens the microphone itself, no sound
 * reaches Branch at all and the window handed on is empty.
 */
async function* windowsOfSound(deps: WakeWordDeps, signal: AbortSignal): AsyncIterable<WakeChunk> {
  const platform = deps.platform ?? process.platform;
  while (!signal.aborted) {
    const { wake, capture } = wakeParts(deps.store, deps.owner, platform, deps.present ?? onThisComputer);
    if (capture.kind === "spotter-listens") { yield { sound: new Uint8Array(0), seconds: wake.windowSeconds }; continue; }
    if (!capture.command) return;
    let sound: Uint8Array | null = await deps.capture(capture.command, wake.windowSeconds, signal);
    if (signal.aborted) return;
    const window = { sound, seconds: wake.windowSeconds };
    sound = null; // the one copy is the one handed on; this binding lets go of it here
    yield window;
  }
}

/** Listens, again and again, starting an ordinary turn each time the word is heard. */
async function keepListening(deps: WakeWordDeps, controller: AbortController, done: () => void): Promise<void> {
  try {
    while (!controller.signal.aborted) {
      const answer = await listenForWake(deps, windowsOfSound(deps, controller.signal));
      if (controller.signal.aborted || answer.refusal || !answer.heard) return;
      await deps.onHeard(answer.text);
    }
  } finally { done(); }
}

/**
 * The listener the app owns. It runs only while the switch is on, a word is chosen, and this
 * computer can really listen; it stops when any of those stops being true — Lockdown coming on, the
 * owner turning the switch off, or the app closing — and lets go of the microphone when it does.
 */
export function startWakeWord(deps: WakeWordDeps): WakeWordListener {
  const platform = deps.platform ?? process.platform;
  const present = deps.present ?? onThisComputer;
  let running: AbortController | null = null;
  let loop: Promise<void> = Promise.resolve();
  const listener: WakeWordListener = {
    get listening() { return running !== null; },
    refresh() {
      if (wakeRefusal(deps.store, deps.owner, platform, present)) { void listener.stop(); return; }
      if (running) return;
      const controller = new AbortController();
      running = controller;
      loop = keepListening(deps, controller, () => { if (running === controller) running = null; });
    },
    async stop() {
      const controller = running;
      running = null;
      controller?.abort();
      await loop.catch(() => undefined);
    },
  };
  listener.refresh();
  return listener;
}
