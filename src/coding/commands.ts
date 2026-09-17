import type { Call, Reply } from "../commands/handlers.js";
import { existingInstructionFile, initPrompt } from "./init.js";
import { codingOn, codingLabels } from "./settings.js";

/**
 * R17-037: `/init` in the message box. It sends the request that has the model look around and write
 * the file with `project.init`; with the part off it says so, and with an instruction file already
 * there it says the text will come back as a proposal rather than replace anything.
 */
export function initCommand(call: Call): Reply {
  const { runtime } = call.host;
  if (!codingOn(runtime.store, runtime.owner, "init"))
    return { text: `${codingLabels.init} is switched off. Switch it on in Settings, Developer, to use /init.` };
  const already = existingInstructionFile(runtime.workspace);
  const text = already ? `${initPrompt} ${already} already exists, so propose the new text instead of replacing it.` : initPrompt;
  return { text: "Asking Branch to write this project's instruction file.", client: { do: "send", text } };
}
