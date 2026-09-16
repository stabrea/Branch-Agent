/**
 * Talk mode: hold the button, speak, let go, and the assistant answers out loud. The four states
 * it moves through are kept here, away from the browser, so the behaviour can be checked without a
 * microphone, a speaker or a single sound being made. The screen draws whatever `status` says.
 */
export type TalkState = "idle" | "listening" | "thinking" | "speaking";
export type TalkEvent = "press" | "release" | "transcribed" | "answered" | "spoken" | "interrupt" | "failed";

export interface TalkStep {
  state: TalkState;
  /** The line shown under the composer, in plain language. */
  status: string;
  /** True when the step should stop whatever sound is playing. */
  stopSound: boolean;
}

const statusFor: Record<TalkState, string> = {
  idle: "Hold the Talk button and speak",
  listening: "Listening… let go when you are done",
  thinking: "Working on your answer",
  speaking: "Reading the answer aloud — press Talk to stop",
};

/**
 * One move of the state machine. Pressing Talk while it is speaking interrupts, which is the whole
 * point of the button: a person can cut the assistant off the way they would another person.
 */
export function talkNext(state: TalkState, event: TalkEvent): TalkStep {
  if (event === "failed") return step("idle", false);
  if (event === "interrupt") return step("idle", true);
  if (event === "press") {
    if (state === "speaking") return step("idle", true);
    if (state === "idle") return step("listening", false);
    return step(state, false);
  }
  if (event === "release") return state === "listening" ? step("thinking", false) : step(state, false);
  if (event === "transcribed") return state === "thinking" ? step("thinking", false) : step(state, false);
  if (event === "answered") return state === "thinking" ? step("speaking", false) : step(state, false);
  if (event === "spoken") return state === "speaking" ? step("idle", false) : step(state, false);
  return step(state, false);
}

function step(state: TalkState, stopSound: boolean): TalkStep {
  return { state, status: statusFor[state], stopSound };
}

/** A small machine a caller can hold on to, for the screen and for the tests. */
export class TalkMode {
  private current: TalkState = "idle";
  get state(): TalkState { return this.current; }
  get status(): string { return statusFor[this.current]; }
  send(event: TalkEvent): TalkStep {
    const next = talkNext(this.current, event);
    this.current = next.state;
    return next;
  }
  reset(): void { this.current = "idle"; }
}

/**
 * Realtime voice sessions over the OpenAI Realtime WebSocket (audit A1212 and A2293) are not
 * built. Branch's network policy checks ordinary HTTP addresses before every request, and it has
 * no hook for a WebSocket, so a realtime session would either bypass that check or need a new
 * dependency — both of which this build refuses. Hold-to-talk above does the same job over the
 * ordinary routes. This is written down here, and in the documentation, rather than half-built.
 */
export const realtimeNote =
  "Live two-way voice calls with a model are not part of Branch yet. Hold-to-talk records, writes out what you said, answers, and reads the answer back, which needs no always-on connection.";
