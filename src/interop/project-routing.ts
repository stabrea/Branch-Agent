import { z } from "zod";
import type { Project } from "../projects.js";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { requireInterop } from "./settings.js";

/**
 * Choosing the project a request belongs to. Each project may carry a few words of its own ("tax",
 * "invoices", "the garden"); a request is scored on those, the project's name, its folder and its
 * repository, and the best one is named with the words that decided it. Nothing is guessed: when no
 * project scores, the answer is "stay where you are". Switching is a separate, explicit step, and
 * only the owner's own window or the route asked with `switch` does it.
 *
 * The idea is from botler-agent's request dispatcher; this is an independent implementation.
 */
const RoutesSchema = z.record(z.string(), z.array(z.string().trim().min(2).max(40)).max(20));
const routesKey = "interop-project-routes";

const words = (text: string): string[] =>
  text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length >= 2);

export interface RouteChoice { projectId: string; name: string; score: number; matched: string[]; reason: string }

/** Every project's score for one request, best first. Pure, so it can be checked on its own. */
export function scoreProjects(projects: Project[], keywords: Record<string, string[]>, request: string): RouteChoice[] {
  const said = new Set(words(request));
  const text = ` ${words(request).join(" ")} `;
  return projects.map((project) => {
    const matched = new Set<string>();
    let score = 0;
    for (const phrase of keywords[project.id] ?? []) {
      const joined = words(phrase).join(" ");
      if (joined && text.includes(` ${joined} `)) { matched.add(phrase); score += 3; }
    }
    const own = [project.name, project.id, project.folder.split("/").pop() ?? "", project.repository.split("/").pop() ?? ""];
    for (const word of new Set(own.flatMap(words))) if (word.length >= 3 && said.has(word)) { matched.add(word); score += 2; }
    const reason = score ? `Mentions ${[...matched].join(", ")}` : "Nothing in the request points here";
    return { projectId: project.id, name: project.name, score, matched: [...matched], reason };
  }).sort((a, b) => b.score - a.score || a.projectId.localeCompare(b.projectId));
}

export class ProjectRouter {
  constructor(private readonly store: Store, private readonly owner: string) {}
  keywords(): Record<string, string[]> {
    const parsed = RoutesSchema.safeParse(this.store.get("settings", this.owner, routesKey)?.data ?? {});
    return parsed.success ? parsed.data : {};
  }
  setKeywords(projectId: string, list: unknown): Record<string, string[]> {
    if (!this.store.projects.list(this.owner).some((p) => p.id === projectId)) throw new Error("Project not found");
    const next = { ...this.keywords(), [projectId]: z.array(z.string().trim().min(2).max(40)).max(20).parse(list) };
    this.store.save("settings", this.owner, routesKey, next);
    return next;
  }
  /** The project a request belongs to, or the active one when nothing points elsewhere. */
  route(request: string): { chosen: RouteChoice; active: string; changes: boolean; ranking: RouteChoice[] } {
    requireInterop(this.store, this.owner, "project-routing");
    const active = this.store.projects.active(this.owner);
    const ranking = scoreProjects(this.store.projects.list(this.owner), this.keywords(), request);
    const top = ranking[0];
    const tie = ranking[1] && top && ranking[1].score === top.score;
    const chosen = top && top.score > 0 && !tie ? top
      : { projectId: active.id, name: active.name, score: 0, matched: [], reason: tie ? "Two projects fit equally well, so nothing changes" : "Nothing in the request points elsewhere" };
    return { chosen, active: active.id, changes: chosen.projectId !== active.id, ranking: ranking.slice(0, 5) };
  }
  /** Routes and, when asked, switches — the audited switch the Projects screen uses. */
  routeAndSwitch(request: string, doSwitch: boolean) {
    const result = this.route(request);
    if (doSwitch && result.changes) this.store.projects.setActive(this.owner, { active: result.chosen.projectId });
    return { ...result, switched: doSwitch && result.changes };
  }
}

export function registerProjectRouting(registry: ToolRegistry, router: ProjectRouter): void {
  registry.register({
    name: "project.route", group: "memory", permission: "memory.read",
    description: "Which of the owner's projects a request belongs to, and why. Changes nothing.",
    parameters: z.object({ request: z.string().trim().min(1).max(4000) }).strict(),
    execute: async (args) => router.route(args.request),
  });
}
