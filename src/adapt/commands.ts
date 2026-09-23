import type { Call, Reply } from "../commands/handlers.js";
import { adaptFor, continuationFor } from "./host.js";
import { adaptMode } from "./settings.js";

/**
 * mac7/adapt: `/adapt` in the message box and the terminal.
 *
 *   /adapt              what stopped the last task, what would fix it, and what that costs
 *   /adapt <sentence>   the same for a sentence Branch said, word for word
 *   /adapt yes <line>   the owner's yes to exactly that offer: get it, then carry the task on
 *
 * The bare form only ever describes. The yes carries the offer's own line, so it can never agree to
 * an offer nobody read: change the offer and the yes is refused with nothing fetched or changed.
 */
export async function adaptCommand(call: Call): Promise<Reply> {
  const { runtime } = call.host;
  const adapt = adaptFor(runtime.store, runtime.owner, { writer: "owner-by-command", source: "command", detail: "/adapt yes" });
  const argument = call.argument.trim();
  const agreement = /^yes\s+([a-f0-9]{32})$/i.exec(argument);
  if (!agreement) {
    const view = await adapt.look(argument ? { said: argument.slice(0, 400) } : {}, { source: "owner" });
    if (view.refusal || !view.fix) return { text: view.message };
    if (view.fix.instead) return { text: view.message };
    return { text: `${view.message} To let it, type: /adapt yes ${view.fix.fingerprint}` };
  }
  const answer = await adapt.go({ agreed: agreement[1]!.toLowerCase() }, { source: "owner" });
  if (!answer.done || !answer.stop) return { text: answer.message };
  // Carrying on is the stop record handed back, not the request run again: the steps it had already
  // finished are named as finished, and the work starts at the step it stopped on.
  return { text: answer.message, client: { do: "send", text: continuationFor(answer.stop, answer.gained) } };
}

/** What `/adapt` says in the commands list, so a surface can show whether it would do anything. */
export const adaptOffered = (call: Call): boolean =>
  adaptMode(call.host.runtime.store, call.host.runtime.owner) !== "off";
