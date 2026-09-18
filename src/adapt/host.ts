import { localKitFor } from "../local-kit.js";
import { saveLocalModelsMode } from "../local-jobs.js";
import { localModelsSetting } from "../local-jobs.js";
import { oneButtonSetting, saveOneButtonMode, type PressContext } from "../local-one-button.js";
import type { Store } from "../store.js";
import { Adapt, type OneButtonLike } from "./service.js";
import type { AdaptStop } from "./stops.js";

/**
 * mac7/adapt: the running Branch's own `/adapt`, wired to the pieces it borrows — the one button
 * (which installs, and asks its own switch while doing it) and the two switches it can turn on.
 *
 * Nothing here installs, downloads or changes anything of its own: every one of those steps is a
 * call into code that already existed and already asks the owner.
 */

/** The one button of this running Branch, or undefined where models on this computer are not set up. */
function oneButtonOf(store: Store, owner: string): OneButtonLike | undefined {
  const kit = localKitFor(store);
  if (!kit) return undefined;
  return {
    plan: (input, context: PressContext) => kit.oneClick.buttonPlan(input, context)
      .then((view) => ({ install: view.install, alreadyInstalled: view.alreadyInstalled })),
    press: (input, context: PressContext) => kit.oneClick.buttonGo(input, context).then((answer) => ({ message: answer.message })),
  };
}

/**
 * Carrying on: the task is handed its own stop record as a continuation. The steps it had already
 * finished are named as done and must not be done again; the work starts at the step it stopped on.
 */
export function continuationFor(stop: AdaptStop, gained: string): string {
  const already = stop.done.length
    ? `These steps are already finished and must not be done again: ${stop.done.join("; ")}. ` : "";
  return `Carry on with ${stop.what}. ${already}Start at: ${stop.nextStep}. `
    + `What was missing has been got: ${gained}`;
}

export function adaptFor(store: Store, owner: string): Adapt {
  const button = oneButtonOf(store, owner);
  return new Adapt({
    store, owner, ...(button ? { oneButton: button } : {}),
    turnOn: (setting) => {
      if (setting === localModelsSetting) saveLocalModelsMode(store, owner, { mode: "when-needed" });
      else if (setting === oneButtonSetting) saveOneButtonMode(store, owner, { mode: "when-needed" });
      else throw new Error("Branch does not turn that switch on from here.");
    },
  });
}
