import { z } from "zod";
import { scrubSecrets } from "../locker.js";
import type { NetworkPolicy } from "../network-policy.js";
import type { ToolRegistry } from "../registry.js";

/**
 * Reading from GitLab: the issues on a project, its releases and how its pipelines went. Only
 * reading — GitLab's write endpoints are shaped differently enough from GitHub's that pretending
 * otherwise would mislead. The key is a personal access token from the owner's secrets; it travels
 * in the header, never in a web address, and is scrubbed out of everything reported back.
 */
export const GitLabConfigSchema = z.object({
  apiBase: z.string().url().default("https://gitlab.com/api/v4"),
  tokenSecret: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).default("GITLAB_TOKEN"),
  timeoutMs: z.number().int().min(1000).max(60000).default(20000),
  maxBytes: z.number().int().min(4096).max(1048576).default(262144),
}).strict();
export type GitLabConfig = z.infer<typeof GitLabConfigSchema>;
/** A project is written the way GitLab writes it: group/name, or group/subgroup/name. */
export const projectPath = z.string().regex(/^[A-Za-z0-9._-]{1,60}(?:\/[A-Za-z0-9._-]{1,60}){1,4}$/, "Write the project as group/name");

export class GitLabAccess {
  private readonly config: GitLabConfig;
  constructor(input: unknown, private readonly policy: NetworkPolicy, private readonly token: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = globalThis.fetch, private readonly userAgent = "BranchAgent") {
    this.config = GitLabConfigSchema.parse(input);
  }
  get tokenSecret(): string { return this.config.tokenSecret; }

  private async request(path: string): Promise<unknown> {
    const token = await this.token();
    const url = new URL(path.replace(/^\//, ""), this.config.apiBase.replace(/\/?$/, "/"));
    await this.policy.assertAllowed(url, "GitLab address");
    const response = await this.fetchImpl(url, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(this.config.timeoutMs),
      headers: { "private-token": token, accept: "application/json", "user-agent": this.userAgent },
    });
    const text = scrubSecrets((await response.text()).slice(0, this.config.maxBytes), { [this.config.tokenSecret]: token });
    if (!response.ok) throw new Error(explainGitLab(response.status, text));
    return text ? JSON.parse(text) : [];
  }
  private id(project: string): string { return encodeURIComponent(project); }

  async issues(input: { project: string; state: "opened" | "closed" | "all"; limit: number }): Promise<unknown> {
    const list = (await this.request(`projects/${this.id(input.project)}/issues?state=${input.state}&per_page=${input.limit}`)) as Record<string, unknown>[];
    return {
      project: input.project,
      issues: (Array.isArray(list) ? list : []).slice(0, input.limit).map((issue) => ({
        number: issue.iid, title: String(issue.title ?? "").slice(0, 200),
        state: issue.state, address: issue.web_url, at: issue.created_at,
      })),
    };
  }
  async releases(input: { project: string; limit: number }): Promise<unknown> {
    const list = (await this.request(`projects/${this.id(input.project)}/releases?per_page=${input.limit}`)) as Record<string, unknown>[];
    return {
      project: input.project,
      releases: (Array.isArray(list) ? list : []).slice(0, input.limit).map((release) => ({
        tag: String(release.tag_name ?? ""), name: String(release.name ?? "").slice(0, 200),
        at: String(release.released_at ?? ""), notes: String(release.description ?? "").slice(0, 2000),
      })),
    };
  }
  /** How the automatic checks went on a branch or a commit, newest first. */
  async pipelines(input: { project: string; ref?: string | undefined; limit: number }): Promise<unknown> {
    const query = new URLSearchParams({ per_page: String(input.limit), ...(input.ref ? { ref: input.ref } : {}) });
    const list = (await this.request(`projects/${this.id(input.project)}/pipelines?${query}`)) as Record<string, unknown>[];
    const runs = (Array.isArray(list) ? list : []).slice(0, input.limit).map((run) => ({
      id: run.id, ref: String(run.ref ?? ""), result: String(run.status ?? ""), address: String(run.web_url ?? ""), at: String(run.updated_at ?? ""),
    }));
    return {
      project: input.project, pipelines: runs,
      summary: !runs.length ? "No pipelines have run on this yet."
        : `The most recent one ${runs[0]!.result === "success" ? "passed" : `came back "${runs[0]!.result}"`}.`,
    };
  }
}

/** GitLab's HTTP answers in words the owner can act on. */
export function explainGitLab(status: number, text: string): string {
  const detail = (/"message"\s*:\s*"([^"]{0,200})"/.exec(text)?.[1] ?? "").trim();
  if (status === 401) return "GitLab did not accept the token. Save a new personal access token in your secrets.";
  if (status === 403) return `GitLab refused this${detail ? `: ${detail}` : ""}. The token may be missing permission.`;
  if (status === 404) return "GitLab could not find that project, or the token cannot see it.";
  if (status >= 500) return "GitLab is having trouble right now. Try again shortly.";
  return `GitLab answered ${status}${detail ? `: ${detail}` : ""}.`;
}

/** Reading from GitLab; registered only when the owner has named it with a saved token. */
export function registerGitLab(registry: ToolRegistry, gitlab: GitLabAccess): void {
  registry.register({
    name: "gitlab.issues", permission: "gitlab.read", group: "git",
    description: "List the issues on a GitLab project, newest first.",
    parameters: z.object({
      project: projectPath, state: z.enum(["opened", "closed", "all"]).default("opened"),
      limit: z.number().int().min(1).max(50).default(20),
    }).strict(),
    execute: (input) => gitlab.issues(input),
  });
  registry.register({
    name: "gitlab.releases", permission: "gitlab.read", group: "git",
    description: "The published releases of a GitLab project, newest first.",
    parameters: z.object({ project: projectPath, limit: z.number().int().min(1).max(30).default(10) }).strict(),
    execute: (input) => gitlab.releases(input),
  });
  registry.register({
    name: "gitlab.pipelines", permission: "gitlab.read", group: "git",
    description: "How the automatic checks went on a GitLab project, for a branch or for all of it.",
    parameters: z.object({
      project: projectPath, ref: z.string().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(30).default(10),
    }).strict(),
    execute: (input) => gitlab.pipelines(input),
  });
}
