/**
 * The page's way to the phone's secure storage (iOS Keychain, Android Keystore). The key a paired
 * Branch hands over never reaches this page: the native side makes the pairing request, keeps what
 * comes back, and adds it to every request itself. What the page can see is only whether a Branch is
 * paired and at which address. `plugin` is the native BranchPhone plugin, or a fake in the tests.
 */
import { checkAddress, pairingBody, readSwitches, refusal } from "./rules.js";

const FIELDS = ["origin", "deviceId", "pairedAt"];

export function createVault(plugin) {
  if (!plugin) throw refusal("phone.notInApp", "This page is not running inside the phone app.");
  return {
    /** Pairs through the native side, which keeps the key. Answers the paired address. */
    async pair(invitation, code, name) {
      const origin = checkAddress(invitation.origin);
      const body = pairingBody(invitation.offerId, code, name);
      const result = await plugin.pair({ origin, ...body });
      if (!result?.paired) throw result?.error ? new Error(result.error) : refusal("phone.error.pairFailed", "That did not work. Make a new invitation on the computer.");
      return origin;
    },
    /** What the page may know: the address and when it was paired, never the key. */
    async current() {
      const saved = (await plugin.session()) ?? {};
      if (!saved.paired) return null;
      const out = {};
      for (const field of FIELDS) if (typeof saved[field] === "string") out[field] = saved[field];
      if (!out.origin) return null;
      checkAddress(out.origin);
      return out;
    },
    forget: () => plugin.forget(),
    /** A request to the paired Branch; the native side adds the key and refuses other addresses. */
    async request(method, path, body, raw) {
      if (!/^\/api\/[a-z0-9/_-]+$/i.test(path)) throw refusal("phone.error.request", "Only Branch's own requests can be sent.");
      // `raw` carries bytes that are not JSON (a recording): { base64, contentType, query }.
      const answer = await plugin.request({ method, path, body: body === undefined ? null : body, ...(raw ?? {}) });
      if (answer.status >= 400) throw new Error(answer.data?.error || `Branch answered ${answer.status}.`);
      return answer.data;
    },
    async switches() { return readSwitches((await plugin.getSwitches())?.switches); },
    async setSwitch(name, position) {
      const next = readSwitches({ ...(await this.switches()), [name]: position });
      await plugin.setSwitches({ switches: next });
      return next;
    },
  };
}
