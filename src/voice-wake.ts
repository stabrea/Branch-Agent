import { z } from "zod";
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

const windowsSpotter = (word: string, sureness: number): WakeSpotter => ({
  available: true,
  how: "Windows' own speech recognition, which runs on this computer and needs nothing installed.",
  command: {
    file: "powershell.exe",
    // The word is never put into the script text. PowerShell's -Command takes one string and glues
    // any words after it onto the end of that same string, so an argument there would be read as
    // PowerShell after all; the word is handed over in the environment instead, where it is only
    // ever a value (integration review, mac7/wake-pins).
    args: ["-NoProfile", "-NonInteractive", "-Command", windowsScript],
    env: wakeEnvironment(word, sureness),
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
const windowsScript = [
  "$Word = $env:BRANCH_WAKE_WORD",
  "$Sureness = [double]$env:BRANCH_WAKE_SURENESS",
  "Add-Type -AssemblyName System.Speech",
  "$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine",
  "$choices = New-Object System.Speech.Recognition.Choices($Word)",
  "$builder = New-Object System.Speech.Recognition.GrammarBuilder($choices)",
  "$engine.LoadGrammar((New-Object System.Speech.Recognition.Grammar($builder)))",
  "$engine.SetInputToWaveStream([Console]::OpenStandardInput())",
  "$heard = $engine.Recognize()",
  "if ($heard -and $heard.Confidence -ge $Sureness) { Write-Output $heard.Text }",
].join("; ");

const ownSpeechProgram = (settings: VoiceSettings, word: string): WakeSpotter => ({
  available: true,
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
): WakeSpotter {
  if (!wake.word) return { available: false, how: "No word has been chosen yet.", command: null };
  if (settings.localSpeechExecutable && settings.localSpeechModel) return ownSpeechProgram(settings, wake.word);
  if (platform === "win32") return windowsSpotter(wake.word, wake.sureness);
  return nothingHere(platform);
}

/* ---------- starting, and every reason not to ---------- */

/** Why listening for the word is refused right now, or null. Every sentence is one the owner reads. */
export function wakeRefusal(store: Store, owner: string, platform: string = process.platform): string | null {
  const wake = wakeWordSettings(store, owner);
  if (wake.mode === "off")
    return lockdownOverrides(store, owner, wakeWordKey)
      ? "Lockdown is on, so nothing is listening for your word. Turn Lockdown off in Settings to allow this again."
      : "The wake word is switched off, so nothing is listening. Turn it on in Settings, Voice.";
  if (!wake.word) return "No word has been chosen yet, so there is nothing to listen for. Choose one in Settings, Voice.";
  const spotter = wakeSpotter(voiceSettings(store, owner), wake, platform);
  if (!spotter.available) return spotter.how;
  return null;
}

/**
 * The plain truth about this feature today, said on the card and in docs/configuration.md.
 *
 * Nothing opens the microphone. `listenForWake` is handed sound by its caller, and there is no
 * caller: no part of Branch records anything or feeds it. So however the switch is set and whatever
 * this computer could do, the wake word does nothing on its own yet, and the card must say so
 * rather than reading as though it were listening (integration review, mac7/wake-pins).
 */
export const captureNote = "Branch does not open the microphone yet, so nothing is fed to this listener and the wake word does nothing on its own today. What is set here is remembered, and the card says what this computer would use once the microphone is wired up.";

/** What the card shows: the switch, the word, and what this computer would really do. */
export function wakeWordState(store: Store, owner: string, platform: string = process.platform): {
  settings: WakeWordSettings; spotter: WakeSpotter; refusal: string | null; mode: FeatureMode;
  listening: boolean; capture: string;
} {
  const settings = wakeWordSettings(store, owner);
  return {
    settings, mode: settings.mode,
    spotter: wakeSpotter(voiceSettings(store, owner), settings, platform),
    refusal: wakeRefusal(store, owner, platform),
    // Never true while nothing feeds the listener, whatever the switch says.
    listening: false, capture: captureNote,
  };
}

/**
 * The same, as it goes over the wire. The program that would be run never travels: its full path is
 * a thing of the owner's, and the card only ever shows the sentence and whether there is a spotter
 * at all. What is left is the switch, the word, that sentence, and why it is refused right now.
 */
export function wakeWordView(
  store: Store, owner: string, platform: string = process.platform, isOwner = true,
): {
  settings: Omit<WakeWordSettings, "word"> & { word?: string }; spotter: { available: boolean; how: string };
  refusal: string | null; mode: FeatureMode; listening: boolean; capture: string; wordChosen: boolean;
} {
  const state = wakeWordState(store, owner, platform);
  const { word, ...rest } = state.settings;
  return {
    ...state,
    // The word is the owner's own. Somebody else on this computer is told whether one has been
    // chosen — which is why nothing is listening — and never what it is (integration review).
    settings: isOwner ? state.settings : rest,
    wordChosen: word.length > 0,
    spotter: { available: state.spotter.available, how: state.spotter.how },
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
): Promise<{ heard: boolean; refusal: string | null; windowsTried: number; windowsTooLong: number }> {
  const platform = deps.platform ?? process.platform;
  const refusal = wakeRefusal(deps.store, deps.owner, platform);
  if (refusal) return { heard: false, refusal, windowsTried: 0, windowsTooLong: 0 };
  const wake = wakeWordSettings(deps.store, deps.owner);
  const spotter = wakeSpotter(voiceSettings(deps.store, deps.owner), wake, platform);
  let windowsTried = 0, windowsTooLong = 0;
  /** The only copy of any sound this function ever holds; replaced, never added to, never written. */
  let held: Uint8Array | null = null;
  for await (const chunk of sound) {
    // More than the owner allowed to be held at once is dropped where it arrives, without being
    // looked at, so the promise on the card is kept however the sound is handed over.
    if (chunk.seconds > wake.windowSeconds) { windowsTooLong += 1; continue; }
    held = chunk.sound;
    windowsTried += 1;
    const answer = await askSpotter(deps.runner, spotter, wake.word, held);
    held = null; // thrown away before the next window, heard or not
    if (answer.heard) return { heard: true, refusal: null, windowsTried, windowsTooLong };
  }
  return { heard: false, refusal: null, windowsTried, windowsTooLong };
}
