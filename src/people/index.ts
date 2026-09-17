import type { DatabaseSync } from "node:sqlite";
import { AuthLimiter } from "../auth-limits.js";
import type { ProfileRoles } from "../profile-roles.js";
import type { Profiles } from "../profiles.js";
import type { SessionTokens } from "../session-tokens.js";
import type { Store } from "../store.js";
import { boundDoorRefusal, personDoorRefusal } from "./access.js";
import { enterPerson } from "./context.js";
import { PeopleGroups } from "./groups.js";
import { PersonKeys, personKeyPrefix, type PersonKeyEntry } from "./keys.js";
import type { GuardedFetch } from "./oidc.js";
import { Passkeys } from "./passkeys.js";
import { ResetCodes } from "./reset-codes.js";
import { peopleEnabled, peopleSettings } from "./settings.js";
import { SignIns } from "./sign-in.js";

/**
 * Bucket 19: more than one person, safely. Everything a person signing in from their own device
 * needs, in one object the app holds. It ships off (src/people/settings.ts).
 */
export interface PeopleParts {
  store: Store; owner: string; db: DatabaseSync; roles: ProfileRoles; tokens: SessionTokens;
  fetch: GuardedFetch; secret: (name: string) => Promise<string | undefined>;
}

export const peopleOffRefusal = "Signing in from other devices is switched off. The owner can switch it on in Settings.";

export class People {
  readonly keys: PersonKeys;
  readonly passkeys: Passkeys;
  readonly groups: PeopleGroups;
  readonly signIns: SignIns;
  readonly resetCodes = new ResetCodes();
  /** Wrong answers on the sign-in page, counted per place, apart from the computer's own key. */
  readonly limiter = new AuthLimiter();
  /** A person's own conversation lent to the assistant while their task runs, so they can still watch it. */
  readonly lent = new Map<string, string>();
  constructor(readonly parts: PeopleParts) {
    this.keys = new PersonKeys(parts.db, parts.owner);
    this.passkeys = new Passkeys(parts.store, parts.owner);
    this.groups = new PeopleGroups(parts.store, parts.owner);
    this.signIns = new SignIns({
      profiles: this.profiles, passkeys: this.passkeys, settings: () => this.settings(),
      fetch: parts.fetch, secret: parts.secret,
    });
    parts.roles.narrowers.push(this.groups.narrow);
    // A key handed to another device for one conversation is held to it (src/session-tokens.ts).
    parts.tokens.boundCheck = (sessionId, method, path) =>
      boundDoorRefusal(sessionId, method, path, (runId) => parts.store.run(runId)?.sessionId ?? null);
  }
  get profiles(): Profiles { return this.parts.store.profiles; }
  settings() { return peopleSettings(this.parts.store, this.parts.owner); }
  enabled(): boolean { return peopleEnabled(this.parts.store, this.parts.owner); }

  static isPersonKey(supplied: string): boolean { return supplied.startsWith(personKeyPrefix); }

  /**
   * The server's check for a person's key: the switch, the key, the profile, and the address. On a
   * yes the rest of the request is that person's. Answers the plain refusal, or null.
   */
  admit(supplied: string, method: string | undefined, path: string): string | null {
    if (!this.enabled()) return peopleOffRefusal;
    const found = this.keys.check(supplied);
    if (typeof found === "string") return found;
    if (!this.profiles.list().some((profile) => profile.id === found.profileId)) {
      this.keys.revokeAll(found.profileId);
      return "That person is no longer on this computer.";
    }
    const refused = personDoorRefusal(method, path, found.method === "setup");
    if (refused) return refused;
    enterPerson({ profileId: found.profileId, keyId: found.id });
    return null;
  }

  /** The entry for the key this request came with (for "who am I" and signing out). */
  entryFor(keyId: string): PersonKeyEntry | null {
    return this.keys.list().find((entry) => entry.id === keyId) ?? null;
  }

  /** Forgets a person everywhere this feature keeps anything about them. */
  forgetProfile(profileId: string): void {
    this.keys.revokeAll(profileId);
    this.passkeys.forget(profileId);
    this.groups.forgetProfile(profileId);
  }
}
