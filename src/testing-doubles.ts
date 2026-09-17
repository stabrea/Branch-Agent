/**
 * The other three doubles: a live conversation, speech in and out, and a sandbox. They live in the
 * program rather than in the test folder, for the same reason `ScriptedProvider` does — a plugin or
 * skill author writing tests against Branch needs them, and a study has to be able to run without a
 * service answering the telephone or a container starting.
 *
 * Every one of them answers by what it was given rather than by how many times it has been called,
 * and none of them looks at the clock, makes an identifier up, or counts across calls. Ask the same
 * question twice and the answer is the same both times, byte for byte, which is the whole point.
 */
import type {
  RealtimeSession, RealtimeSettings, RealtimeToolCall, RealtimeUsage, TranscriptPart,
} from "./realtime.js";
import type { AudioClip, TranscriptionResult } from "./voice-stt.js";
import type { SpokenAudio } from "./voice-tts.js";
import type {
  SandboxAvailability, SandboxBackend, SandboxBackendName, SandboxCollected, SandboxCommand,
  SandboxHandle, SandboxLimits, SandboxRunResult, SandboxSlice, SandboxStart,
} from "./sandbox-backends.js";

const free = { amount: 0, currency: "USD", confidence: "free", note: "A scripted double; nothing was sent anywhere." } as const;
const bytesOf = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "utf8"));

/* ------------------------------------------------------------------ live conversation */

/** One exchange: a phrase to listen for, and everything the service does when it hears it. */
export interface ScriptedTurn {
  /** Found anywhere in what the person said. The first turn that fits answers. */
  hear: string;
  /** What the assistant says back, both as words and as the sound of those words. */
  say?: string;
  /** A tool the model asks for in the middle of the turn. */
  call?: { name: string; arguments: unknown };
  usage?: RealtimeUsage;
}

/**
 * A live conversation that never opens a socket. Speaking is writing text as audio: a test sends
 * the words as bytes, and the double reads them back, so the whole path — audio in, transcript,
 * tool call, audio out — can be exercised with nothing running.
 */
export class ScriptedRealtime implements RealtimeSession {
  readonly service: "openai" | "gemini";
  /** Everything the person said, in order, whether typed or spoken. */
  readonly heard: string[] = [];
  /** Every piece of sound the assistant produced, as the text it stands for. */
  readonly spoken: string[] = [];
  /** Tool answers handed back, so a test can say what the model was told. */
  readonly toolResults: { callId: string; name: string; result: unknown }[] = [];
  readonly interruptions: number[] = [];
  opened = false;
  closedWith: string | null = null;
  onTranscript: (part: TranscriptPart) => void = () => undefined;
  onAudio: (pcm16: Uint8Array) => void = () => undefined;
  onToolCall: (call: RealtimeToolCall) => void = () => undefined;
  onUsage: (usage: RealtimeUsage) => void = () => undefined;
  onClosed: (reason: string) => void = () => undefined;
  onError: (message: string) => void = () => undefined;
  private pending: string[] = [];
  constructor(
    private readonly script: readonly ScriptedTurn[] = [],
    readonly settings: Partial<RealtimeSettings> = {},
    service: "openai" | "gemini" = "openai",
  ) { this.service = service; }

  async open(): Promise<void> { this.opened = true; }
  sendAudio(chunk: Uint8Array): void { this.pending.push(Buffer.from(chunk).toString("utf8")); }
  commit(): void {
    const said = this.pending.join("");
    this.pending = [];
    if (said) this.sendText(said);
  }
  sendText(text: string): void {
    this.heard.push(text);
    this.onTranscript({ who: "person", text, final: true });
    const index = this.script.findIndex((turn) => text.includes(turn.hear));
    if (index < 0) { this.onError(`Nothing scripted for: ${text.slice(0, 120)}`); return; }
    this.answer(this.script[index]!, index);
  }
  /** The service's half of one turn. The call's number comes from the script, never from a counter. */
  private answer(turn: ScriptedTurn, index: number): void {
    if (turn.call)
      this.onToolCall({ id: `scripted-turn-${index}`, name: turn.call.name, arguments: JSON.stringify(turn.call.arguments ?? {}) });
    if (turn.say !== undefined) {
      this.onTranscript({ who: "assistant", text: turn.say, final: true });
      this.spoken.push(turn.say);
      this.onAudio(bytesOf(turn.say));
    }
    if (turn.usage) this.onUsage(turn.usage);
  }
  toolResult(callId: string, name: string, result: unknown): void { this.toolResults.push({ callId, name, result }); }
  interrupt(): void { this.interruptions.push(this.heard.length); this.pending = []; }
  close(reason = "the test closed it"): void {
    if (this.closedWith !== null) return;
    this.closedWith = reason;
    this.onClosed(reason);
  }
}

/* --------------------------------------------------------------------------- speech */

/**
 * Speech in and out with nothing installed and nothing paid for. A clip is "heard" as whatever a
 * test said it holds, falling back to reading the bytes as text — which is how a test writes one.
 */
export class ScriptedSpeech {
  readonly transcribed: string[] = [];
  readonly asked: { text: string; voice: string }[] = [];
  private readonly heard = new Map<string, string>();
  /** What a clip with this name is heard as. */
  hears(name: string, text: string): this { this.heard.set(name, text); return this; }
  async transcribe(clip: AudioClip): Promise<TranscriptionResult> {
    this.transcribed.push(clip.name);
    const text = this.heard.get(clip.name) ?? Buffer.from(clip.bytes).toString("utf8");
    return { text, route: "local", language: null, cost: { ...free } };
  }
  /** The sound of a sentence is its own text, so a test can read back what was said. */
  async speak(request: { text: string; voice?: string | undefined }): Promise<SpokenAudio> {
    const voice = request.voice ?? "scripted";
    this.asked.push({ text: request.text, voice });
    return { bytes: bytesOf(request.text), mediaType: "audio/wav", route: "windows", voice, cost: { ...free } };
  }
}

/* -------------------------------------------------------------------------- sandbox */

/** What a scripted sandbox hands back for one program. */
export interface ScriptedRun { stdout?: string; stderr?: string; exitCode?: number; status?: string }

/**
 * A sandbox backend that says it is there and never starts anything. `started` holds exactly what
 * would have been run, which is what a test asserts on, and every run takes zero milliseconds so
 * two runs of the same study compare equal.
 */
export class ScriptedSandbox implements SandboxBackend {
  readonly started: SandboxStart[] = [];
  readonly collected: string[] = [];
  disposed = 0;
  private readonly replies = new Map<string, ScriptedRun>();
  constructor(readonly name: SandboxBackendName = "docker", private readonly mount = "/work") {}
  /** What one program hands back. A program with nothing set exits 0 and says nothing. */
  reply(executable: string, run: ScriptedRun): this { this.replies.set(executable, run); return this; }
  async available(): Promise<SandboxAvailability> { return { ok: true, reason: "" }; }
  async prepare(slice: SandboxSlice): Promise<SandboxHandle> {
    const backend = this;
    const argvFor = async (command: SandboxCommand): Promise<SandboxStart> => {
      const start = { executable: command.executable, args: [...command.args], cwd: slice.hostPath, env: {} };
      backend.started.push(start);
      return start;
    };
    return {
      backend: backend.name,
      mount: backend.mount,
      argvFor,
      async run(command: SandboxCommand, _limits: SandboxLimits, _signal: AbortSignal): Promise<SandboxRunResult> {
        const start = await argvFor(command);
        const reply = backend.replies.get(command.executable) ?? {};
        return {
          status: reply.status ?? "completed", exitCode: reply.exitCode ?? 0,
          stdout: reply.stdout ?? "", stderr: reply.stderr ?? "", truncated: false,
          durationMs: 0, backend: backend.name, isolation: "sampling",
          argv: [start.executable, ...start.args],
        };
      },
      async collect(paths: string[]): Promise<SandboxCollected[]> {
        backend.collected.push(...paths);
        return paths.map((path) => ({ path, bytes: 0 }));
      },
      async dispose(): Promise<void> { backend.disposed += 1; },
    };
  }
}
