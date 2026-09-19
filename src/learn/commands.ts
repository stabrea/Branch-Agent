import type { Call, Reply } from "../commands/handlers.js";
import { learnLabel, learnSettings } from "./settings.js";

/**
 * mac7/learn: `/learn` on every surface that reads the one command table.
 *
 * On its own it says what the feature is, whether it is switched on and how long a tour will be --
 * a look, and nothing is spent. With something after it (`/learn code src`, `/learn documents
 * Handbook`) it sends the request that has the assistant build the map and walk through it with
 * `learn.map` and `learn.tour`, which is where the cost preview and the owner's yes live.
 *
 * Nothing here builds a map itself. A command that quietly read a whole folder because somebody
 * typed a word would be the hook Understand Anything ships and Branch refuses (see
 * THIRD_PARTY_NOTICES.md): the owner presses the button, every time.
 */
export function learnCommand(call: Call): Reply {
  const { runtime } = call.host;
  const settings = learnSettings(runtime.store, runtime.owner);
  if (settings.mode === "off")
    return { text: `${learnLabel} is switched off. The owner can switch it on in Branch, in Documents.` };
  const said = call.argument.trim();
  if (!said)
    return { text: `${learnLabel} is on. Say what to understand: "/learn code src" for a folder of code, `
      + `or "/learn documents Handbook" for a knowledge base. You get a map of what is in there and a walk `
      + `through it in up to ${settings.steps} stops, each naming the line or passage it came from. `
      + "Building the map calls no model and costs nothing; only the words on each stop ever do." };
  const [first, ...rest] = said.split(/\s+/);
  const subject = first === "documents" || first === "code" ? first : "code";
  const of = (first === "documents" || first === "code" ? rest.join(" ") : said).trim();
  const where = of ? ` of ${of}` : "";
  return {
    text: `Asking Branch for a map${where} and a walk through it.`,
    client: { do: "send", text: `Build me a map of the ${subject === "code" ? "code in" : "knowledge base"} `
      + `${of || "this project"} with learn.map, tell me what a tour would cost with learn.cost before spending `
      + "anything, then walk me through it with learn.tour. Under every claim, show me the line or the passage "
      + "it came from, and say plainly which claims have nothing behind them." },
  };
}
