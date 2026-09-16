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
 * Wave 8: the note the Voice screen shows about a live conversation. Hold-to-talk above is still
 * what happens on a connection that does not offer one, and it is still the only thing that works
 * when the owner has asked for sound to stay on this computer.
 */
export const realtimeNote =
  "A live conversation — where you talk and it answers as you go, and you can cut in — needs a connection that offers one, which today means OpenAI or Gemini. On anything else, hold the Talk button instead: it records, writes out what you said, answers, and reads the answer back.";

/* ---------- Wave 8: the same button, in a live conversation ---------- */

/**
 * A live conversation moves differently from hold-to-talk: the microphone stays open, the answer
 * arrives while it is still being said, and pressing the button in the middle of it cuts in and
 * goes straight back to listening rather than stopping. These are the states for that, kept here
 * for the same reason as the four above: so the behaviour can be checked without a microphone.
 */
export type LiveState = "idle" | "listening-live" | "speaking" | "interrupted";
export type LiveEvent = "start" | "answering" | "press" | "resumed" | "finished" | "stop" | "failed";

const liveStatusFor: Record<LiveState, string> = {
  idle: "Press Talk to start a live conversation",
  "listening-live": "Listening — talk whenever you like, and press Talk to stop",
  speaking: "Answering — press Talk to cut in",
  interrupted: "Stopping — carry on talking",
};

export interface LiveStep {
  state: LiveState;
  status: string;
  /** True when the step should stop whatever sound is playing right now. */
  stopSound: boolean;
  /** True when the step should tell the other side to stop talking. */
  interrupt: boolean;
}

/**
 * One move. Pressing Talk while it is answering is the whole point: the answer is cancelled, the
 * sound stops, and it is listening again a moment later without the person doing anything else.
 */
export function liveNext(state: LiveState, event: LiveEvent): LiveStep {
  if (event === "failed" || event === "stop") return liveStep("idle", true, false);
  if (event === "start") return state === "idle" ? liveStep("listening-live", false, false) : liveStep(state, false, false);
  if (event === "answering")
    return state === "listening-live" || state === "interrupted" ? liveStep("speaking", false, false) : liveStep(state, false, false);
  if (event === "press") {
    if (state === "speaking") return liveStep("interrupted", true, true);
    if (state === "idle") return liveStep("listening-live", false, false);
    return liveStep("idle", true, false);
  }
  if (event === "resumed")
    return state === "interrupted" ? liveStep("listening-live", false, false) : liveStep(state, false, false);
  if (event === "finished")
    return state === "speaking" ? liveStep("listening-live", false, false) : liveStep(state, false, false);
  return liveStep(state, false, false);
}
function liveStep(state: LiveState, stopSound: boolean, interrupt: boolean): LiveStep {
  return { state, status: liveStatusFor[state], stopSound, interrupt };
}

/** A small machine the screen and the tests both hold on to, as with hold-to-talk above. */
export class LiveTalkMode {
  private current: LiveState = "idle";
  get state(): LiveState { return this.current; }
  get status(): string { return liveStatusFor[this.current]; }
  send(event: LiveEvent): LiveStep {
    const next = liveNext(this.current, event);
    this.current = next.state;
    return next;
  }
  reset(): void { this.current = "idle"; }
}
