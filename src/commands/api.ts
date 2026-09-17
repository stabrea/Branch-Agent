import { z } from "zod";
import type { createBranch } from "../index.js";
import { COMMANDS, levelFor, surfaces } from "./catalog.js";
import { commandHost } from "./host.js";
import { commandSettings, listed, available, saveCommandSettings } from "./settings.js";
import { commandFor, executeCommand } from "./execute.js";
import { PARITY } from "./parity.js";
import type { Access } from "./handlers.js";

/**
 * The commands' routes (wave mac3, commands). The window, the phone and the dashboard read their
 * list here and carry commands out here; the terminal and the chat apps call the same code directly.
 *
 *   GET  /api/commands?surface=window|phone|dashboard   the list that surface offers
 *   GET  /api/commands/table                            every command on every surface, and the parity table
 *   GET  /api/commands/run?surface=…&line=…&session=…   a command that only looks (any key)
 *   POST /api/commands/run { surface, line, sessionId }  any command the key allows
 *   GET/POST /api/commands/settings                     the switch; changing it needs the key of this computer
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;
export class CommandApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const WebSurface = z.enum(["window", "phone", "dashboard"]);
const RunBody = z.object({
  surface: WebSurface, line: z.string().trim().min(1).max(16000), sessionId: z.string().uuid().optional(),
}).strict();

export const handlesCommandsPath = (path: string): boolean => path === "/api/commands" || path.startsWith("/api/commands/");

export interface CommandApiDeps {
  method: string;
  url: URL;
  access: Access;
  readBody: () => Promise<unknown>;
}

function listFor(app: Branch, surface: z.infer<typeof WebSurface>) {
  const mode = commandSettings(app.store, app.runtime.owner).mode;
  const commands = COMMANDS.filter((command) => available(command, surface, mode)).map((command) => ({
    name: command.name, aliases: command.aliases, args: command.args, key: command.key, english: command.english,
    level: command.level, bareLooks: command.bareLooks === true, listed: listed(command, surface, mode),
  }));
  return { surface, mode, commands };
}

async function run(app: Branch, deps: CommandApiDeps, input: z.infer<typeof RunBody>, onlyLooking: boolean) {
  if (input.sessionId && !app.store.ownsSession(app.runtime.owner, input.sessionId))
    throw new CommandApiError(404, "Conversation not found");
  const host = commandHost(app.runtime, app);
  if (onlyLooking) {
    const parsed = commandFor(host, input.surface, input.line);
    if (parsed && levelFor(parsed.command, parsed.argument) !== "look")
      throw new CommandApiError(405, "That command changes something; send it with POST.");
  }
  const outcome = await executeCommand(host, {
    surface: input.surface, line: input.line, sessionId: input.sessionId, access: deps.access,
  });
  return outcome ? { handled: true, ...outcome } : { handled: false };
}

export async function commandsApi(app: Branch, path: string, deps: CommandApiDeps): Promise<unknown> {
  const { method, url } = deps;
  if (method === "GET" && path === "/api/commands") return listFor(app, WebSurface.parse(url.searchParams.get("surface") ?? "window"));
  if (method === "GET" && path === "/api/commands/table")
    return { surfaces, commands: COMMANDS, parity: PARITY, mode: commandSettings(app.store, app.runtime.owner).mode };
  if (path === "/api/commands/run") {
    if (method === "POST") return run(app, deps, RunBody.parse(await deps.readBody()), false);
    const input = RunBody.parse({
      surface: url.searchParams.get("surface") ?? "window", line: url.searchParams.get("line") ?? "",
      ...(url.searchParams.get("session") ? { sessionId: url.searchParams.get("session") } : {}),
    });
    return run(app, deps, input, true);
  }
  if (path === "/api/commands/settings") {
    if (method === "GET") return { ...commandSettings(app.store, app.runtime.owner), access: deps.access };
    if (deps.access !== "full") throw new CommandApiError(403, "Only the key of this computer can change which commands are offered.");
    app.store.profiles.requireOwner("Which commands are offered");
    return saveCommandSettings(app.store, app.runtime.owner, await deps.readBody());
  }
  throw new CommandApiError(404, "Not found");
}
