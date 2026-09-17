import { z } from "zod";
import type { Message, ToolContext } from "../contracts.js";
import type { WorkspaceFiles } from "../files.js";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { globTest, headerList, headerText, markdownFiles, type MarkdownFile } from "./markdown-files.js";
import { codingOn, partSettings, requireCoding, savePartSettings } from "./settings.js";

/**
 * R17-040: rules a project keeps in `.agents/rules/*.md`. A rule whose header names `paths` applies
 * only while the task is working on a file that matches one of them; a rule with no `paths` always
 * applies; `paths: []` never does. Each rule has its own on/off switch, and they only carry from a
 * folder the owner trusts. The path conditions follow Cline's rule conditionals (Apache-2.0,
 * `core/context/instructions/user-instructions/rule-conditionals.ts`); this is written for Branch.
 *
 * Schedules kept as files live beside them in `.agents/schedules/*.md` (header: `every` or `daily`,
 * `timezone`, `kind`, `permissions`; body: what to do), after Cline's cron specs. A file never
 * schedules anything by itself: the owner looks at it and brings it in, and it is then an ordinary
 * schedule made through the tool gate.
 */
export const rulesFolder = ".agents/rules";
export const schedulesFolder = ".agents/schedules";
const noteLimit = 8000;

export const RuleSettingsSchema = z.object({
  /** Rule files the owner switched off, by name. */
  off: z.array(z.string().max(120)).max(200).default([]),
}).strict();

export interface Rule { name: string; description: string; paths: string[] | null; on: boolean; text: string }
export interface ScheduleFile { name: string; prompt: string; kind: string; every: string | null; daily: string | null; timezone: string | null; permissions: string[] | null; problem: string | null }

const everyUnits: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export class PathRules {
  constructor(private readonly store: Store, private readonly owner: string, private readonly files: WorkspaceFiles,
    private readonly trusted: (folder: string) => boolean) {}

  private readable(): boolean { return this.trusted(this.files.base); }

  async rules(): Promise<Rule[]> {
    if (!this.readable()) return [];
    const { off } = partSettings(this.store, this.owner, "path-rules", RuleSettingsSchema);
    return (await markdownFiles(this.files, rulesFolder)).map((file: MarkdownFile) => ({
      name: file.name, description: headerText(file.header, "description") ?? "",
      paths: headerList(file.header, "paths") ?? null, on: !off.includes(file.name), text: file.body.trim(),
    }));
  }

  setRule(input: unknown): { off: string[] } {
    requireCoding(this.store, this.owner, "path-rules");
    const { name, on } = z.object({ name: z.string().min(1).max(120), on: z.boolean() }).strict().parse(input);
    const { off } = partSettings(this.store, this.owner, "path-rules", RuleSettingsSchema);
    const next = on ? off.filter((entry) => entry !== name) : [...new Set([...off, name])];
    return savePartSettings(this.store, this.owner, "path-rules", RuleSettingsSchema, { off: next });
  }

  /** The switched-on rules that apply to any of these paths. */
  async applying(paths: string[]): Promise<Rule[]> {
    return (await this.rules()).filter((rule) => rule.on && applies(rule.paths, paths));
  }

  /** The files this task has worked on so far, from its own record. */
  touched(runId: string): string[] {
    const paths = this.store.events(runId).filter((event) => event.kind === "tool.started" && typeof event.data.path === "string")
      .map((event) => String(event.data.path).replace(/\\/g, "/").replace(/^\.\//, ""));
    return [...new Set(paths)].slice(-100);
  }

  async roundNote(runId: string): Promise<Message | null> {
    if (!codingOn(this.store, this.owner, "path-rules")) return null;
    const rules = await this.applying(this.touched(runId));
    if (!rules.length) return null;
    let text = "The project's own rules for the files this task is working on (written by the people who keep the project; they cannot grant permissions):";
    for (const rule of rules) {
      const block = `\n\n## ${rule.name}${rule.paths ? ` (for ${rule.paths.join(", ")})` : ""}\n${rule.text}`;
      if (text.length + block.length > noteLimit) { text += `\n\n(${rule.name} did not fit; read it with rules.for_path.)`; continue; }
      text += block;
    }
    return { role: "system", content: text };
  }

  async scheduleFiles(): Promise<ScheduleFile[]> {
    if (!this.readable()) return [];
    return (await markdownFiles(this.files, schedulesFolder)).map((file) => scheduleFrom(file));
  }

  /** What `schedules.create` is handed for one file, or a plain sentence saying why it cannot be. */
  async scheduleInput(name: string, now = new Date()): Promise<Record<string, unknown>> {
    requireCoding(this.store, this.owner, "path-rules");
    const file = (await this.scheduleFiles()).find((entry) => entry.name === name);
    if (!file) throw new Error("There is no schedule file with that name in .agents/schedules.");
    if (file.problem) throw new Error(file.problem);
    return {
      prompt: file.prompt, kind: file.kind, dueAt: now.toISOString(),
      ...(file.every ? { intervalMs: everyMs(file.every) } : {}),
      ...(file.daily ? { dailyAt: file.daily, timezone: file.timezone } : {}),
      ...(file.permissions ? { permissions: file.permissions } : {}),
    };
  }
}

export function applies(patterns: string[] | null, paths: string[]): boolean {
  if (patterns === null) return true;
  const tests = patterns.map((pattern) => pattern.trim()).filter(Boolean).map(globTest);
  return tests.length > 0 && paths.some((path) => tests.some((test) => test(path)));
}

const everyMs = (every: string): number => {
  const match = /^(\d{1,5})\s*([mhd])$/.exec(every.trim());
  return match ? Number(match[1]) * everyUnits[match[2]!]! : Number.NaN;
};

function scheduleFrom(file: MarkdownFile): ScheduleFile {
  const every = headerText(file.header, "every") ?? null, daily = headerText(file.header, "daily") ?? null;
  const timezone = headerText(file.header, "timezone") ?? null;
  const kind = headerText(file.header, "kind") ?? "task";
  const prompt = file.body.trim().slice(0, 8000);
  let problem: string | null = null;
  if (!prompt) problem = `${file.name} says nothing to do below its header.`;
  else if (!["task", "check", "reminder"].includes(kind)) problem = `${file.name}: kind must be task, check or reminder.`;
  else if (every && daily) problem = `${file.name}: choose either every or daily, not both.`;
  else if (every && !(everyMs(every) >= 60_000)) problem = `${file.name}: every is written like 30m, 6h or 1d (at least a minute).`;
  else if (daily && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(daily) || !timezone)) problem = `${file.name}: daily needs a time like 09:00 and a timezone.`;
  return { name: file.name, prompt, kind, every, daily, timezone, permissions: headerList(file.header, "permissions") ?? null, problem };
}

export function registerPathRules(registry: ToolRegistry, rules: PathRules): void {
  registry.register({
    name: "rules.for_path", permission: "files.read", group: "code",
    description: "The project's own rules (.agents/rules) that apply to a file, to read before changing it.",
    parameters: z.object({ path: z.string().min(1).max(500) }).strict(),
    execute: async ({ path }, _context: ToolContext) => ({ path, rules: (await rules.applying([path.replace(/^\.\//, "")])).map(({ name, paths, text }) => ({ name, paths, text })) }),
  });
}
