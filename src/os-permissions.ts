import { execFile } from "node:child_process";
import { join } from "node:path";

/**
 * What Windows itself will let this app do. Branch has always had its own switches — "Allow the
 * assistant to use my screen and keyboard", "Let Branch look up passwords" — but Windows has
 * switches of its own, under Settings > Privacy & security, and a refusal there looks to a program
 * like nothing happening at all. Asking first means the person is told what to turn on, in one plain
 * sentence with the button that opens the right page, instead of watching something quietly fail.
 *
 * Nothing here asks Windows for a permission: only the person can grant one. It reads what they
 * have already chosen, and for the screen it tries the smallest possible action to find out.
 */
export const osCapabilities = ["microphone", "camera", "screen"] as const;
export type OsCapability = (typeof osCapabilities)[number];

/** What Windows says: yes, no, or nothing this computer can answer. */
export type ConsentState = "allowed" | "refused" | "unknown";
export type ConsentReader = (capability: OsCapability) => Promise<ConsentState>;

export interface CapabilityCheck {
  capability: OsCapability;
  state: ConsentState;
  /** True unless Windows said no outright; "unknown" never stops anything. */
  allowed: boolean;
  /** One plain sentence for the person, or "" when there is nothing to say. */
  message: string;
  /** The Windows page that turns it on, or "" when there is no page for it. */
  settingsLink: string;
}

const settingsLinks: Record<OsCapability, string> = {
  microphone: "ms-settings:privacy-microphone",
  camera: "ms-settings:privacy-webcam",
  screen: "ms-settings:privacy-graphicscaptureprogrammatic",
};
const refusals: Record<OsCapability, string> = {
  microphone: "Windows is not letting Branch use the microphone, so nothing you say can be written down. Open Windows Settings, Privacy & security, Microphone, and turn it on for this app.",
  camera: "Windows is not letting Branch use the camera. Open Windows Settings, Privacy & security, Camera, and turn it on for this app.",
  screen: "Windows is not letting Branch take hold of other programs' windows, so it cannot use your screen and keyboard. Open Windows Settings, Privacy & security, and turn screen access on for this app.",
};

/** What one reading means for the person: whether to go ahead, and what to tell them if not. */
export function capabilityCheck(capability: OsCapability, state: ConsentState): CapabilityCheck {
  const allowed = state !== "refused";
  return {
    capability, state, allowed,
    message: allowed ? "" : refusals[capability],
    settingsLink: allowed ? "" : settingsLinks[capability],
  };
}

/** Where Windows keeps what the person chose for the microphone and the camera. */
const consentKeys: Partial<Record<OsCapability, string>> = {
  microphone: "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone",
  camera: "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\webcam",
};

/** Reads one registry value; anything at all going wrong is simply "nothing this computer can say". */
function registryValue(root: string, key: string, name: string): Promise<string | null> {
  const system = process.env.SystemRoot;
  if (process.platform !== "win32" || !system) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(join(system, "System32", "reg.exe"), ["query", `${root}\\${key}`, "/v", name],
      { timeout: 4000, windowsHide: true, shell: false, maxBuffer: 16384, env: { SystemRoot: system, PATH: "" } },
      (error, stdout) => {
        if (error) return resolve(null);
        const match = /\bREG_SZ\s+(\S+)/i.exec(String(stdout));
        resolve(match ? match[1]! : null);
      });
  });
}

/**
 * What the person chose for one capability. The machine-wide setting is read first because a
 * refusal there cannot be overridden per user; then the user's own. "Deny" is the only answer that
 * stops anything: a key that is not there means this build of Windows keeps no such setting.
 */
export const windowsConsent: ConsentReader = async (capability) => {
  const key = consentKeys[capability];
  if (!key) return "unknown";
  for (const root of ["HKLM", "HKCU"]) {
    const value = await registryValue(root, key, "Value");
    if (value?.toLowerCase() === "deny") return "refused";
    if (value?.toLowerCase() === "allow" && root === "HKCU") return "allowed";
  }
  return "unknown";
};

/**
 * Windows keeps no switch for taking hold of another program's window, so the only way to find out
 * is to try the smallest thing screen control does — ask for the list of open windows. A reader
 * built this way answers "screen" from that probe and leaves the other two to the registry.
 */
export function probeReader(probe: () => Promise<unknown>, fallback: ConsentReader = windowsConsent): ConsentReader {
  return async (capability) => {
    if (capability !== "screen") return fallback(capability);
    return probe().then((): ConsentState => "allowed").catch((error): ConsentState => probeFailure(error));
  };
}
/**
 * Only a refusal counts as a refusal. A probe that times out on a cold computer, or that cannot find
 * what it needs, says nothing this computer can answer — it must never be read as "Windows said no"
 * and stop screen control outright.
 */
const deniedWords = /\b(access is denied|permission|not permitted|unauthori[sz]ed|elevation|privilege)\b/i;
export function probeFailure(error: unknown): ConsentState {
  const said = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return deniedWords.test(said) ? "refused" : "unknown";
}

export class OsPermissions {
  /** Readings are kept for a short while: the person does not change these between two clicks. */
  private readonly cached = new Map<OsCapability, { at: number; state: ConsentState }>();
  now: () => number = () => Date.now();
  constructor(private readonly read: ConsentReader = windowsConsent, private readonly holdMs = 30_000) {}

  /** What Windows says about one capability right now, with the sentence to show if it says no. */
  async check(capability: OsCapability): Promise<CapabilityCheck> {
    const kept = this.cached.get(capability);
    if (kept && this.now() - kept.at < this.holdMs) return capabilityCheck(capability, kept.state);
    const state = await this.read(capability).catch((): ConsentState => "unknown");
    this.cached.set(capability, { at: this.now(), state });
    return capabilityCheck(capability, state);
  }
  /** Every capability at once, for the settings screen. */
  async all(): Promise<CapabilityCheck[]> {
    return Promise.all(osCapabilities.map((capability) => this.check(capability)));
  }
  /** Forgets what was read, so a person who has just changed a Windows switch is believed. */
  forget(): void { this.cached.clear(); }
}
