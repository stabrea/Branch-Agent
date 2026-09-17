import type { Call, Reply } from "../commands/handlers.js";
import { reachFor } from "./index.js";
import { isPaused, platformSettings, setPaused } from "./platform.js";
import { reachOffSentence } from "./settings.js";

/**
 * R17-081: `/platform` in the window and the terminal (the table entry is in
 * src/commands/catalog.ts). It is the owner's, so the shared table's owner check applies. In a chat
 * app the same words are handled before any command, only from the owner's own accounts
 * (`platformGate` in src/reach/platform.ts), because the shared table never lets a chat change
 * anything.
 */
type Handler = (call: Call) => Reply | Promise<Reply>;
const say = (text: string): Reply => ({ text });

const platform: Handler = (call) => {
  const reach = reachFor(call.host.runtime);
  if (!reach) return say("This part of Branch is not in this copy.");
  if (reach.mode("platform-pause") === "off") return say(reachOffSentence("platform-pause"));
  call.host.requireOwner("/platform");
  const [word = "status", channel] = call.argument.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const { store, owner } = reach;
  if (word === "status") {
    const paused = platformSettings(store, owner).paused.filter((id) => isPaused(store, owner, id));
    return say(paused.length ? `Paused: ${paused.join(", ")}.` : "No chat app is paused.");
  }
  if ((word !== "pause" && word !== "resume") || !channel || !/^[a-z0-9._-]{1,64}$/.test(channel))
    return say("Use /platform pause <chat app>, /platform resume <chat app>, or /platform status.");
  setPaused(store, owner, channel, word === "pause", `with /platform on the ${call.surface}`);
  return say(word === "pause" ? `${channel} is paused: its messages are let go until you resume it.` : `${channel} is answering again.`);
};

export const REACH_HANDLERS: Record<string, Handler> = { platform };
