import { z } from "zod";
import { FeatureModeSchema } from "../feature-switches.js";
import { SetupRefusal } from "./check.js";
import { saveSetup, saveSetupMode, setupList, setupPanel, type SetupHost } from "./service.js";

/**
 * The Set up panel's routes. Looking needs nothing more than the app's key; changing the switch or
 * saving a token is the owner's alone (and a short-lived key is refused before it gets here).
 *
 *   GET  /api/channel-setup              the switch and the list of apps
 *   POST /api/channel-setup              {"mode": "off" | "when-needed" | "on"}
 *   GET  /api/channel-setup/<id>         one app's panel: the command, the links, the square codes
 *   POST /api/channel-setup/<id>/check   {"values": {...}, "enable": "on"}: check, save, switch on if asked
 */
export const handlesChannelSetupPath = (path: string): boolean => path === "/api/channel-setup" || path.startsWith("/api/channel-setup/");

const CheckBodySchema = z.object({
  values: z.record(z.string().max(40), z.string().max(4000)).refine((values) => Object.keys(values).length <= 12, "Too many values"),
  enable: FeatureModeSchema.optional(),
}).strict();

export interface ChannelSetupDeps extends SetupHost {
  requireOwner: (what: string) => void;
}

export async function channelSetupApi(deps: ChannelSetupDeps, method: string, path: string, readBody: () => Promise<unknown>): Promise<unknown> {
  if (path === "/api/channel-setup") {
    if (method === "GET") return setupList(deps.store, deps.owner);
    if (method !== "POST") throw new SetupRefusal(405, "Use GET or POST here.");
    deps.requireOwner("Setting up chat apps");
    saveSetupMode(deps.store, deps.owner, await readBody());
    return setupList(deps.store, deps.owner);
  }
  const check = /^\/api\/channel-setup\/([a-z][a-z0-9-]{0,29})\/check$/.exec(path);
  if (check) {
    if (method !== "POST") throw new SetupRefusal(405, "Use POST here.");
    deps.requireOwner("Saving a chat app's token");
    const body = CheckBodySchema.safeParse(await readBody());
    if (!body.success) throw new SetupRefusal(400, "Send the pasted values, and optionally how to switch the app on.");
    return saveSetup(deps, check[1]!, { values: body.data.values, enable: body.data.enable });
  }
  const panel = /^\/api\/channel-setup\/([a-z][a-z0-9-]{0,29})$/.exec(path);
  if (panel && method === "GET") return setupPanel(deps.store, deps.owner, panel[1]!);
  throw new SetupRefusal(404, "Not found");
}
