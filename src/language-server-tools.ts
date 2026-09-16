import { z } from "zod";
import type { ToolRegistry } from "./registry.js";
import type { CodeChanges } from "./code-change.js";
import type { LanguageServers } from "./language-server.js";

/**
 * The language-server tools. Four of them only look at things; the fifth, renaming, goes through
 * exactly the same gate as any other multi-file change: the person sees which files it touches,
 * all of them change or none of them do, and each keeps its previous bytes.
 */
const path = z.string().min(1).max(500);
const line = z.number().int().min(1).max(1000000).describe("Counting from 1.");
const character = z.number().int().min(1).max(10000).describe("Counting from 1.");

export function registerLanguageServers(registry: ToolRegistry, servers: LanguageServers, changes: CodeChanges): void {
  registry.register({
    name: "code.diagnostics", permission: "files.read", group: "code",
    description: "Mistakes and warnings a language server reports for one file, or everything it has said so far when no file is named. Needs a language server the owner has set up.",
    parameters: z.object({ path: path.optional(), waitMs: z.number().int().min(0).max(10000).default(1500) }).strict(),
    execute: (args, context) => servers.diagnostics(args, context.runId),
  });
  registry.register({
    name: "code.definition", permission: "files.read", group: "code",
    description: "Where the name at this place in a file is defined.",
    parameters: z.object({ path, line, character }).strict(),
    execute: (args, context) => servers.definition(args, context.runId),
  });
  registry.register({
    name: "code.references", permission: "files.read", group: "code",
    description: "Everywhere the name at this place in a file is used.",
    parameters: z.object({ path, line, character, includeDeclaration: z.boolean().default(true) }).strict(),
    execute: (args, context) => servers.references(args, context.runId),
  });
  registry.register({
    name: "code.hover", permission: "files.read", group: "code",
    description: "What a language server says about the name at this place: its type and the note written above it.",
    parameters: z.object({ path, line, character }).strict(),
    execute: (args, context) => servers.hover(args, context.runId),
  });
  registry.register({
    name: "code.rename", permission: "files.write", group: "code",
    description: "Rename the name at this place everywhere it is used, as one change across files. You are shown which files it touches first; they all change or none of them do, and each can be put back.",
    parameters: z.object({
      path, line, character,
      newName: z.string().trim().min(1).max(200).regex(/^[A-Za-z_$][\w$]*$/, "A name uses letters, digits and underscores"),
      dryRun: z.boolean().default(false),
    }).strict(),
    target: (args) => (args.dryRun ? "" : `rename to ${args.newName} from ${args.path}`),
    execute: async (args, context) => {
      const planned = await servers.renameEdits(args, context.runId);
      return changes.applyPlanned(`rename to ${args.newName}`, planned, args.dryRun, context);
    },
  });
}
