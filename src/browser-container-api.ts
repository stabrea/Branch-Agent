import {
  BrowserContainerInputSchema, BrowserContainerSchema, dockerImage, playwrightVersion, readBrowserContainer,
  settingsKey, tokenName, tokenProject,
} from "./integrations/browser-container.js";
import type { Secrets } from "./vault.js";
import type { Store } from "./store.js";

/**
 * w911 (A2019): the routes behind "where the browser runs", in one function so src/server.ts gains a
 * single short block.
 *
 *   GET  /api/browser/container   the switch, where, the address, and whether a token is saved
 *   POST /api/browser/container   saves them; a token goes into the secrets locker and never comes back
 */
export const browserContainerPath = "/api/browser/container";
export const handlesBrowserContainer = (path: string): boolean => path === browserContainerPath;

export interface BrowserContainerDeps {
  store: Store;
  owner: string;
  secrets: () => Secrets;
  requireOwner: (what: string) => void;
}

function tokenSaved(deps: BrowserContainerDeps): boolean {
  try { return deps.secrets().list(deps.owner, tokenProject).some((entry) => entry.name === tokenName); }
  catch { return false; }
}

/** What Settings shows: never the token itself, only whether one is saved. */
export function browserContainerView(deps: BrowserContainerDeps) {
  const saved = readBrowserContainer(deps.store, deps.owner);
  let image = "";
  try { image = dockerImage(playwrightVersion()); } catch { /* shown empty; the refusal says why on use */ }
  return { ...(saved ?? BrowserContainerSchema.parse({})), damaged: saved === null, tokenSaved: tokenSaved(deps), image };
}

export async function saveBrowserContainer(deps: BrowserContainerDeps, input: unknown) {
  const { token, ...given } = BrowserContainerInputSchema.parse(input ?? {});
  const value = BrowserContainerSchema.parse({ ...(readBrowserContainer(deps.store, deps.owner) ?? {}), ...given });
  if (token !== undefined) {
    let secrets: Secrets;
    try { secrets = deps.secrets(); } catch { throw new Error("The secrets locker is not open, so the token cannot be kept."); }
    if (token === null) secrets.remove(deps.owner, tokenProject, tokenName);
    else await secrets.put(deps.owner, tokenProject, tokenName, token);
  }
  deps.store.save("settings", deps.owner, settingsKey, value);
  return browserContainerView(deps);
}

export async function browserContainerApi(deps: BrowserContainerDeps, method: string, body: () => Promise<unknown>) {
  if (method === "GET") return browserContainerView(deps);
  if (method !== "POST") throw new Error("Only reading and saving are possible here");
  deps.requireOwner("Where the browser runs");
  return saveBrowserContainer(deps, await body());
}
