import { lstatSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { slots, writeContextFile, type WrittenFile } from "../context-files.js";
import type { ToolContext } from "../contracts.js";
import type { WorkspaceFiles } from "../files.js";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";

/**
 * R17-037: `/init` — the project's instruction file (AGENTS.md), as Hermes, Codex, Gemini CLI and
 * Claude Code offer. The command asks the model to look around and write it; the tool writes what the
 * model wrote, or a plain draft from the project's own files when it is called with nothing. Writing
 * goes through the context-file loader's own writer (src/context-files.ts), and a project that
 * already has an instruction file is left alone: the text comes back as a proposal instead.
 */
export const initPrompt = "Look around this project — its layout, how it is built, tested and run, and any conventions you can see — "
  + "and write its instruction file for coding agents with the project.init tool. Keep it short and concrete: the commands to build, "
  + "test and lint; where the code lives; conventions a newcomer would miss. Do not include secrets or personal details.";

export const ProjectInitSchema = z.object({
  /** The finished file. Without it a plain draft is made from the project's own files. */
  text: z.string().trim().min(20).max(16000).optional(),
  dryRun: z.boolean().default(false),
}).strict();

interface Facts { name: string; commands: string[]; languages: string[]; folders: string[]; readmeTitle: string }

const markers: [string, string][] = [
  ["package.json", "JavaScript or TypeScript (npm)"], ["tsconfig.json", "TypeScript"], ["pyproject.toml", "Python"],
  ["requirements.txt", "Python"], ["Cargo.toml", "Rust"], ["go.mod", "Go"], ["pom.xml", "Java (Maven)"],
  ["build.gradle", "Java or Kotlin (Gradle)"], ["Gemfile", "Ruby"], ["composer.json", "PHP"], ["Makefile", "make"],
];
const knownCommands: Record<string, string[]> = {
  "Cargo.toml": ["cargo build", "cargo test"], "go.mod": ["go build ./...", "go test ./..."],
  "pyproject.toml": ["python -m pytest"], Makefile: ["make"],
};

async function readSmall(files: WorkspaceFiles, name: string): Promise<string> {
  try { return (await readFile(await files.checked(name), "utf8")).slice(0, 65536); } catch { return ""; }
}

/** What the project's own files say about it, read only through the workspace's checks. */
export async function projectFacts(files: WorkspaceFiles): Promise<Facts> {
  const entries = await readdir(files.base, { withFileTypes: true }).catch(() => []);
  const names = new Set(entries.map((entry) => entry.name));
  const folders = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
    .map((entry) => entry.name).sort().slice(0, 20);
  const languages = [...new Set(markers.filter(([file]) => names.has(file)).map(([, language]) => language))];
  const commands: string[] = [];
  let name = "";
  if (names.has("package.json")) {
    try {
      const pkg = JSON.parse(await readSmall(files, "package.json")) as { name?: unknown; scripts?: Record<string, unknown> };
      name = typeof pkg.name === "string" ? pkg.name : "";
      for (const script of ["build", "test", "lint", "typecheck", "dev", "start"])
        if (pkg.scripts && typeof pkg.scripts[script] === "string") commands.push(`npm run ${script}`);
    } catch { /* a broken package.json only means fewer facts */ }
  }
  for (const [file, lines] of Object.entries(knownCommands)) if (names.has(file)) commands.push(...lines);
  const readme = names.has("README.md") ? await readSmall(files, "README.md") : "";
  const readmeTitle = /^#\s+(.+)$/m.exec(readme)?.[1]?.trim().slice(0, 120) ?? "";
  return { name: name || readmeTitle, commands, languages, folders, readmeTitle };
}

/** A plain first draft from the facts, for the owner to improve. */
export function draftInstructions(facts: Facts): string {
  const lines = [`# ${facts.name || "This project"}`, "", "Instructions for coding agents working in this project.", ""];
  if (facts.languages.length) lines.push(`Written in: ${facts.languages.join(", ")}.`, "");
  lines.push("## Commands", ...(facts.commands.length ? facts.commands.map((command) => `- \`${command}\``) : ["- (none found; add how to build and test)"]), "");
  if (facts.folders.length) lines.push("## Layout", ...facts.folders.map((folder) => `- \`${folder}/\``), "");
  lines.push("## Conventions", "- Run the tests before calling a change finished.", "- Keep changes small and focused.");
  return lines.join("\n");
}

const agentsNames = (slots.find((slot) => slot.key === "agents")?.names ?? []) as readonly string[];
/** The instruction file already there, by name only; its contents are the loader's to read. */
export function existingInstructionFile(workspace: string): string | null {
  return [...agentsNames, "GEMINI.md"].find((name) => lstatSync(join(workspace, name), { throwIfNoEntry: false }) !== undefined) ?? null;
}

export type InitOutcome = { written: WrittenFile | null; text: string; reason: string };

export async function initProject(store: Store, files: WorkspaceFiles, input: z.infer<typeof ProjectInitSchema>, context: Pick<ToolContext, "owner">): Promise<InitOutcome> {
  const text = input.text ?? draftInstructions(await projectFacts(files));
  const already = existingInstructionFile(files.base);
  if (already) return { written: null, text, reason: `${already} is already here, so it was left alone. The text above is a proposal to merge by hand.` };
  if (input.dryRun) return { written: null, text, reason: "Nothing was written: this was a preview." };
  const written = writeContextFile(store, context.owner, files.base, { name: "AGENTS.md", text, from: "/init" });
  const reason = written.setting === "off"
    ? "AGENTS.md was written. Branch reads it once \"How the owner wants you to work here\" is switched on in Settings."
    : "AGENTS.md was written.";
  return { written, text, reason };
}

export function registerInit(registry: ToolRegistry, store: Store, files: WorkspaceFiles): void {
  registry.register({
    name: "project.init", permission: "files.write", group: "code",
    description: "Write this project's AGENTS.md instruction file. Pass the finished text; with no text a plain draft is made from the project's files. An existing instruction file is never replaced: the text comes back as a proposal.",
    parameters: ProjectInitSchema,
    target: (input) => (input.dryRun ? "" : "AGENTS.md"),
    execute: (input, context) => initProject(store, files, input, context),
  });
}
