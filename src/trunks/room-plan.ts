/**
 * R17-009 (T-09): who speaks next in a room. A pure function over the room's log, so a restart
 * replays the log and carries on exactly where it stopped.
 *
 * Ported from Hermes Agent `gateway/hosted_room_discussion.py` (`plan_next_task`, `resolve_mentions`,
 * `_unaddressed_member_mentions`, `is_pass_text`, `_build_prompt`), MIT, Copyright (c) 2025 Nous
 * Research; see THIRD_PARTY_NOTICES.md. Branch's rooms have one thread each, so the thread ids are gone.
 *
 * - The owner's message opens a discussion. In the first round the @mentioned members answer, or
 *   everyone when nobody is mentioned (`@all` and `@everyone` also mean everyone).
 * - Later rounds are opt-in: only a member another member @mentioned, and who has not spoken since,
 *   gets another turn.
 * - A member may pass. A round where nobody speaks settles the discussion.
 * - At most 3 rounds and 10 member messages for one message from the owner.
 */
export const maxRoomMembers = 6;
export const minRoomMembers = 2;
export const maxRounds = 3;
export const maxMessagesPerSend = 10;
const maxDeltaLines = 24;
/** The runtime takes a message of at most 16000 characters; leave room for the rules. */
const maxPromptChars = 12000;

export type RoomEventKind = "user" | "member" | "pass" | "failed" | "waiting" | "stopped";
export interface RoomEvent {
  seq: number;
  kind: RoomEventKind;
  text: string;
  at: string;
  /** The Trunk that spoke, passed, failed or is waiting. */
  memberId?: string;
  round?: number;
  /** The seq of the owner's message this turn answered. */
  discussion?: number;
  /** The last seq this member had seen when it took the turn. */
  seen?: number;
  /** For "waiting": the owner has answered, so the turn is taken again. */
  answered?: boolean;
}
export interface RoomMember { id: string; handle: string; name: string }
export interface RoomTask { memberId: string; round: number; discussion: number; seen: number; prompt: string }
export type RoomDecision =
  | { status: "idle" }
  | { status: "task"; task: RoomTask }
  | { status: "waiting"; memberId: string }
  | { status: "settled" | "bounded"; reason: string; discussion: number };

const mention = /@([A-Za-z0-9][A-Za-z0-9._:-]*)/g;
const passText = /^\(?\s*pass\s*\)?\.?$/i;

export function isPass(text: string): boolean {
  const trimmed = text.trim();
  return !trimmed || passText.test(trimmed);
}

/** Members named with @ in these texts; with nobody named, everyone (unless `defaultAll` is off). */
export function resolveMentions(texts: readonly string[], members: readonly RoomMember[], defaultAll = true): RoomMember[] {
  const byHandle = new Map(members.map((m) => [m.handle.toLowerCase(), m]));
  const named = new Set<string>();
  let everyone = false;
  for (const text of texts)
    for (const match of text.matchAll(mention)) {
      const handle = match[1]!.toLowerCase().replace(/[.:]+$/, "");
      if (handle === "all" || handle === "everyone") everyone = true;
      else if (byHandle.has(handle)) named.add(handle);
    }
  if (everyone || (defaultAll && named.size === 0)) return [...members];
  return members.filter((m) => named.has(m.handle.toLowerCase()));
}

/** True when a text calls for the owner: `@you`, `@owner` or `@user`. */
export function asksForOwner(text: string): boolean {
  return [...text.matchAll(mention)].some((m) => ["you", "owner", "user"].includes(m[1]!.toLowerCase().replace(/[.:]+$/, "")));
}

/** Members a member @mentioned and who have not spoken since. */
function unaddressed(messages: readonly RoomEvent[], members: readonly RoomMember[]): RoomMember[] {
  const citedAt = new Map<string, number>();
  const spokeAt = new Map<string, number>();
  for (const event of messages) {
    if (event.kind !== "member" || !event.memberId) continue;
    spokeAt.set(event.memberId, event.seq);
    for (const cited of resolveMentions([event.text], members, false))
      if (cited.id !== event.memberId) citedAt.set(cited.id, event.seq);
  }
  return members.filter((m) => citedAt.has(m.id) && (spokeAt.get(m.id) ?? 0) <= citedAt.get(m.id)!);
}

function rotate<T>(items: readonly T[], by: number): T[] {
  const shift = items.length ? by % items.length : 0;
  return [...items.slice(shift), ...items.slice(0, shift)];
}

/** The owner's message still being discussed: the latest one, unless it was settled or stopped. */
function pendingDiscussion(events: readonly RoomEvent[]): RoomEvent | undefined {
  const latest = [...events].reverse().find((e) => e.kind === "user");
  if (!latest) return undefined;
  const closed = events.some((e) => e.seq > latest.seq && e.kind === "stopped");
  return closed ? undefined : latest;
}

/** What a member last saw, from the turns it has already taken. */
function watermark(events: readonly RoomEvent[], memberId: string): number {
  return events.reduce((seen, e) => (e.memberId === memberId && e.seen !== undefined && e.kind !== "waiting" ? Math.max(seen, e.seen) : seen), 0);
}

function speaker(event: RoomEvent, members: readonly RoomMember[]): string {
  if (event.kind === "user") return "The owner";
  return `@${members.find((m) => m.id === event.memberId)?.handle ?? "someone"}`;
}

/** The turn's message: what is new since this member last spoke, and the rules of the room. */
export function roomPrompt(roomName: string, member: RoomMember, members: readonly RoomMember[], messages: readonly RoomEvent[], seen: number): string {
  const peers = members.filter((m) => m.id !== member.id).map((m) => `@${m.handle}`).join(", ");
  const opening = [`[Room "${roomName}"] You are @${member.handle}, talking with ${peers || "nobody else"} and the owner.`, "",
    "New messages since your last turn (oldest first):"];
  const rules = ["", "How this room works:",
    "- Reply with one short message only when you have something new to add.",
    '- If you have nothing new to add, reply with exactly "(pass)".',
    "- Mention another Trunk by its @name to bring it into the next round; do not repeat what was said.",
    "- Write @you when only the owner can decide something.",
    "- Never reveal anything from a private conversation. Your reply is shown to the whole room as written."];
  let room = maxPromptChars - [...opening, ...rules].join("\n").length;
  const lines: string[] = [];
  for (const event of messages.filter((e) => e.seq > seen).slice(-maxDeltaLines).reverse()) {
    const line = `  ${speaker(event, members)}: ${event.text}`;
    if (line.length + 1 > room) {
      if (!lines.length && room > 32) lines.push(line.slice(0, room - 1));
      lines.push("  [Earlier messages left out to fit this turn.]");
      break;
    }
    lines.push(line);
    room -= line.length + 1;
  }
  return [...opening, ...lines.reverse(), ...rules].join("\n");
}

/** Replays the whole log and answers with at most one next turn. */
export function nextRoomTurn(roomName: string, members: readonly RoomMember[], events: readonly RoomEvent[]): RoomDecision {
  const discussion = pendingDiscussion(events);
  if (!discussion) return { status: "idle" };
  const d = discussion.seq;
  const waiting = events.find((e) => e.kind === "waiting" && e.discussion === d && !e.answered);
  if (waiting?.memberId) return { status: "waiting", memberId: waiting.memberId };
  const thread = events.filter((e) => e.seq >= d && (e.kind === "user" || e.kind === "member"));
  const spoken = thread.filter((e) => e.kind === "member" && e.discussion === d);
  if (spoken.length >= maxMessagesPerSend) return { status: "bounded", reason: "max_messages", discussion: d };
  const done = new Set(events.filter((e) => e.discussion === d && ["member", "pass", "failed"].includes(e.kind)).map((e) => `${e.round}:${e.memberId}`));
  const history = events.filter((e) => e.kind === "user" || e.kind === "member");
  const seenThrough = Math.max(...thread.map((e) => e.seq));
  for (let round = 0; round < maxRounds; round++) {
    const responders = round === 0 ? resolveMentions([discussion.text], members) : unaddressed(spoken, members);
    for (const member of rotate(responders, round)) {
      if (done.has(`${round}:${member.id}`)) continue;
      const seen = watermark(events, member.id);
      if (!history.some((e) => e.seq > seen && e.seq <= seenThrough)) continue;
      const prompt = roomPrompt(roomName, member, members, history.filter((e) => e.seq <= seenThrough), seen);
      return { status: "task", task: { memberId: member.id, round, discussion: d, seen: seenThrough, prompt } };
    }
    if (!spoken.some((e) => e.round === round)) return { status: "settled", reason: "silent_round", discussion: d };
    if (round === maxRounds - 1) return { status: "bounded", reason: "max_rounds", discussion: d };
  }
  return { status: "bounded", reason: "max_rounds", discussion: d };
}
