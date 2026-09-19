import { lockdownActive } from "../lockdown.js";
import { qrTerminal } from "../remote/qr.js";
import type { Store } from "../store.js";
import { PhoneApp, phoneLockdownRefusal, PhoneAppRefusal } from "./index.js";

export const phoneLockdownClosed = "Lockdown was turned on, so the phone download link was closed.";

/**
 * mac7/phone-qr: `branch phone [--address <ip>] [--minutes <n>]`.
 *
 * The same code as the window's card, drawn in the terminal. The link lives exactly as long as the
 * command runs (fifteen minutes unless told otherwise); Ctrl+C ends it at once.
 */
export interface PhoneCommandDeps {
  store: Pick<Store, "get">;
  owner: string;
  phone?: PhoneApp;
  write: (line: string) => void;
  colour: boolean;
  /** How the command learns it should stop early; the real one is Ctrl+C. */
  interrupted?: Promise<void>;
  /** How often to look whether Lockdown was turned on meanwhile. */
  lockdownCheckMs?: number;
}

export function parsePhoneArgs(argv: readonly string[]): { address?: string; minutes?: number } {
  const value = (name: string): string | undefined => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
  const address = value("--address"), minutes = value("--minutes");
  return { ...(address ? { address } : {}), ...(minutes ? { minutes: Number(minutes) } : {}) };
}

export async function phoneCommand(deps: PhoneCommandDeps, argv: readonly string[]): Promise<number> {
  if (lockdownActive(deps.store, deps.owner)) { deps.write(phoneLockdownRefusal); return 1; }
  const phone = deps.phone ?? new PhoneApp();
  const view = await phone.share(parsePhoneArgs(argv)).catch((error: unknown) => {
    if (error instanceof PhoneAppRefusal || error instanceof Error) deps.write(error.message);
    return null;
  });
  if (!view) return 1;
  const others = (await phone.addresses()).filter((address) => address !== view.address);
  deps.write("Get Branch on your phone");
  deps.write("");
  deps.write(qrTerminal(view.qr, deps.colour));
  deps.write("");
  deps.write("Scan this with your Android phone's camera. The phone must be on the same Wi-Fi as this computer.");
  deps.write(`Or open: ${view.url}`);
  deps.write(`The link only downloads the Branch app, and stops working at ${new Date(view.expiresAt).toLocaleTimeString()}. Press Ctrl+C to stop it sooner.`);
  for (const other of others) deps.write(`Phone cannot open it? Try: branch phone --address ${other}`);
  // Lockdown turned on in the window (another process, the same store) ends this link too.
  let watch: NodeJS.Timeout | undefined;
  const lockedDown = new Promise<void>((resolve) => {
    watch = setInterval(() => { if (lockdownActive(deps.store, deps.owner)) resolve(); }, deps.lockdownCheckMs ?? 2000);
  });
  await Promise.race([phone.door.closed(), lockedDown, deps.interrupted ?? new Promise<void>((resolve) => process.once("SIGINT", () => resolve()))]);
  clearInterval(watch);
  phone.stop();
  if (lockdownActive(deps.store, deps.owner)) deps.write(phoneLockdownClosed);
  deps.write("The phone download link is closed.");
  return 0;
}
