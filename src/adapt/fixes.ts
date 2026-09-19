import { createHash } from "node:crypto";
import { planSize, type InstallPlan } from "../local-install.js";
import { runtimeInfo } from "../local-launch.js";
import { localModelsSetting } from "../local-jobs.js";
import { oneButtonSetting } from "../local-one-button.js";
import type { Blocker, ModelKind } from "./blockers.js";

/**
 * mac7/adapt: what would put each blocker right, in plain words, with what it costs.
 *
 * Pure. It works out the offer; nothing here downloads, installs or switches anything on. Every
 * offer carries a fingerprint of itself, exactly as the one-button install does, so the owner's yes
 * can only ever agree to the offer that was on the screen: change the offer and the yes is stale.
 *
 * Some blockers have no honest fix, and those say so rather than half-do something:
 *   - a permission is the person's own to grant, at their computer's own settings;
 *   - a speech program has no source Branch will download from (src/voice-stt.ts says so already);
 *   - a key is the owner's own to paste into the locker;
 *   - a full disk is not something Branch may empty on the owner's behalf.
 */

export interface AdaptFix {
  blocker: Blocker;
  /** What Branch would do, in one plain sentence. */
  what: string;
  /** Where it would come from, in plain words; empty when nothing is fetched. */
  from: string;
  /** How much would be downloaded, in plain words; empty when nothing is downloaded. */
  size: string;
  /** True when the owner must give a key of their own before this can work. */
  needsOwnerKey: boolean;
  /** The one-button install plan, when the fix is installing a program that runs models. */
  install: InstallPlan | null;
  /**
   * Set when nothing Branch can do will fix it: the plain sentence saying so, and what the person
   * could do themselves. An offer with this set installs nothing, whatever the owner answers.
   */
  instead: string | null;
  /** The offer, in one line. Only the offer the owner saw is ever carried out. */
  fingerprint: string;
}

/** The offer as one line, so a yes can only ever agree to the offer that was shown. */
export function fixFingerprint(fix: Omit<AdaptFix, "fingerprint">): string {
  const facts = JSON.stringify([fix.blocker.kind, fix.blocker.what, fix.blocker.modelKind,
    fix.what, fix.from, fix.size, fix.needsOwnerKey, fix.install?.fingerprint ?? null, fix.instead]);
  return createHash("sha256").update(facts).digest("hex").slice(0, 32);
}
const finish = (fix: Omit<AdaptFix, "fingerprint">): AdaptFix => ({ ...fix, fingerprint: fixFingerprint(fix) });
const nothing = { from: "", size: "", needsOwnerKey: false, install: null };

/** An offer that cannot be carried out, and what the person could do instead. */
const cannot = (blocker: Blocker, what: string, instead: string): AdaptFix =>
  finish({ blocker, what, ...nothing, instead });

const modelOffer: Record<ModelKind, string> = {
  speech: "Branch would set up a model on this computer that can read text aloud",
  transcription: "Branch would set up a model on this computer that can write out speech",
  embeddings: "Branch would set up a model on this computer that can compare passages by meaning",
  vision: "Branch would set up a model on this computer that can look at pictures",
  images: "Branch would set up a model on this computer that can draw pictures",
};

/**
 * What Branch offers for one blocker. `install` is the one-button plan when the missing thing is a
 * program that runs models; it is worked out by `installPlan` and carried out by the one button, so
 * `/adapt` never grows a second way to install anything.
 */
export function fixFor(blocker: Blocker, install: InstallPlan | null): AdaptFix {
  switch (blocker.kind) {
    case "runner": return runnerFix(blocker, install);
    case "model": return modelFix(blocker, install);
    case "switch": return switchFix(blocker);
    case "disk": return cannot(blocker, "Nothing Branch installs would make room",
      "There is not enough room on this disk, and emptying it is yours to do. Free some space and ask me again.");
    case "network": return cannot(blocker, "Nothing Branch installs would bring the connection back",
      "This computer cannot reach the internet at the moment. Check the connection, then ask me again.");
    case "permission": return cannot(blocker, "Only you can grant this permission",
      `${blocker.said} Branch cannot grant a permission on your behalf — your computer will only take it from you.`);
    case "key": return cannot(blocker, "Only you can add a key",
      `${blocker.what} needs a key of yours, which only you can paste in. Add it under Settings, Secrets, then ask me again.`);
    case "program": return programFix(blocker);
  }
}

/**
 * The two switches whose own refusal sentences Branch can place exactly. Anything else is named and
 * left to the owner: guessing which switch a sentence meant, and then turning it on, is the one
 * mistake this feature must never make.
 */
export const knownSwitches: { setting: string; label: string; says: RegExp }[] = [
  { setting: localModelsSetting, label: "Models on this computer", says: /Models on this computer are switched off/i },
  { setting: oneButtonSetting, label: "Installing a program that runs models", says: /Branch is not set up to install a program that runs models/i },
];
/** The setting a switched-off sentence is about, or null when Branch cannot say for certain. */
export const switchBehind = (said: string): { setting: string; label: string } | null => {
  const hit = knownSwitches.find((one) => one.says.test(said));
  return hit ? { setting: hit.setting, label: hit.label } : null;
};

function switchFix(blocker: Blocker): AdaptFix {
  const known = switchBehind(blocker.said);
  if (!known) return cannot(blocker, `Branch cannot tell which switch "${blocker.what}" is`,
    `Something is switched off and Branch cannot say for certain which switch it is, so it will not change one at random. ${blocker.said}`);
  return finish({ blocker, what: `Branch would switch "${known.label}" on in Settings for you`, ...nothing, instead: null });
}

function runnerFix(blocker: Blocker, install: InstallPlan | null): AdaptFix {
  if (!install) return cannot(blocker, `Branch cannot install ${blocker.what} on this computer`,
    `Branch has no way to install ${blocker.what} here. Install it yourself from ${installPageFor(blocker.what)}, then ask me again.`);
  if (install.instead) return cannot(blocker, `Branch cannot install ${install.name} on this computer`, install.instead);
  return finish({
    blocker, what: `Branch would install ${install.name}, the program that runs models on this computer`,
    from: install.source, size: planSize(install), needsOwnerKey: false, install, instead: null,
  });
}

/**
 * A missing model is the same offer as a missing program when there is no program to run it yet;
 * with one already there, the model itself is fetched by the one button's ordinary setup.
 */
function modelFix(blocker: Blocker, install: InstallPlan | null): AdaptFix {
  const kind = (blocker.modelKind || "transcription") as ModelKind;
  const withProgram = install && !install.instead;
  return finish({
    blocker, what: withProgram
      ? `${modelOffer[kind]}, installing ${install.name} first because nothing here runs models yet`
      : modelOffer[kind],
    from: withProgram ? install.source : "Branch's own list of models",
    size: withProgram ? planSize(install) : "the model's own size, shown before it starts",
    needsOwnerKey: false, install: withProgram ? install : null, instead: null,
  });
}

/**
 * A program that is not a model runner. Branch installs only what it has a publisher, a checksum
 * and a plan for, which today is the programs that run models; everything else is named plainly
 * and left to the person, rather than fetched from wherever the internet happens to offer it.
 */
function programFix(blocker: Blocker): AdaptFix {
  return cannot(blocker, `Branch does not install ${blocker.what} for you`,
    `${blocker.what} is missing, and Branch has no publisher, checksum and plan it trusts for it, so it will not fetch one. `
    + `Install ${blocker.what} yourself with this computer's usual way of installing programs, then ask me again.`);
}

const installPageFor = (name: string): string =>
  Object.values(runtimeInfo).find((info) => info.name === name)?.installPage ?? runtimeInfo.ollama.installPage;
