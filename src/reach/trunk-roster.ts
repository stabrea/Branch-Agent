import { narrowed } from "../autonomy/runner.js";
import type { ToolRegistry } from "../registry.js";
import type { Runtime } from "../runtime.js";
import type { Trunks } from "../trunks/index.js";
import { trunkMode } from "../trunks/settings.js";
import type { TrunkRoster } from "./remote-trunks.js";

/**
 * R17-077 wired to R17-A's Trunks (src/trunks/). Only Trunks that are not hidden are shared, and
 * only while Trunks and their messages are switched on here.
 *
 * A message from another computer is not the owner speaking: it starts a turn in the Trunk's own
 * conversation marked as another assistant's task (`source: "a2a"`), so the approval rules are
 * capped as for any agent from outside, and with permissions narrowed exactly as an automatic turn's
 * are. It does not wait for the answer. A Trunk that is busy says so, and the other computer's one
 * retry covers it.
 */
export function trunkRoster(trunks: Trunks, runtime: Runtime, registry: ToolRegistry): TrunkRoster {
  const open = (): boolean =>
    trunkMode(runtime.store, runtime.owner, "trunks") !== "off" && trunkMode(runtime.store, runtime.owner, "messages") !== "off";
  const shared = () => (open() ? trunks.records.list().filter((t) => !t.hidden) : []);
  return {
    list: () => shared().map((t) => ({ handle: t.handle, name: t.name, title: t.title ?? "" })),
    deliver: async (handle, message) => {
      const trunk = shared().find((t) => t.handle === handle);
      if (!trunk) return false;
      const started = await new Promise<true | Error>((resolve) => {
        runtime.run({
          prompt: `A message from the Trunk ${message.from}:\n\n${message.text}`, sessionId: trunk.chatSessionId, source: "a2a",
          permissions: narrowed(undefined, registry.permissions()), onTextDelta: () => undefined, onStarted: () => resolve(true),
        }).catch((error: unknown) => resolve(error instanceof Error ? error : new Error(String(error))));
      });
      if (started instanceof Error)
        throw Object.assign(new Error(/active run/.test(started.message) ? `${trunk.name} is busy; try again shortly.` : started.message), { status: 503 });
      return true;
    },
  };
}
