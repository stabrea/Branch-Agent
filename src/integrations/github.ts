import { z } from "zod";
import { scrubSecrets } from "../locker.js";
import type { NetworkPolicy } from "../network-policy.js";

/**
 * A small, direct connection to GitHub for the few things people actually ask for: make me a
 * repository, open a pull request, show me the open issues, raise an issue. It uses a personal
 * access token the owner pastes into their secrets; the token only ever travels in the request
 * header, is never written into a web address, and is scrubbed out of anything reported back.
 */
export const GitHubConfigSchema = z.object({
  apiBase: z.string().url().default("https://api.github.com"),
  /** Name of the secret in the owner's project locker that holds the personal access token. */
  tokenSecret: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).default("GITHUB_TOKEN"),
  timeoutMs: z.number().int().min(1000).max(60000).default(20000),
  maxBytes: z.number().int().min(4096).max(1048576).default(262144),
}).strict();
export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;
export type TokenSource = () => Promise<string>;

export const repositoryName = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, "Repository names use letters, digits, dots, dashes and underscores");
export const repositoryPath = z.string().regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/, "Write the repository as owner/name");

export class GitHubAccess {
  private readonly config: GitHubConfig;
  constructor(input: unknown, private readonly policy: NetworkPolicy, private readonly token: TokenSource,
    private readonly fetchImpl: typeof fetch = globalThis.fetch, private readonly userAgent = "BranchAgent") {
    this.config = GitHubConfigSchema.parse(input);
  }
  get tokenSecret(): string { return this.config.tokenSecret; }

  /** One REST call: the network policy decides whether the address may be reached at all. */
  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await this.token();
    const url = new URL(path.replace(/^\//, ""), this.config.apiBase.replace(/\/?$/, "/"));
    await this.policy.assertAllowed(url, "GitHub address");
    const response = await this.fetchImpl(url, {
      method, redirect: "error", signal: AbortSignal.timeout(this.config.timeoutMs),
      headers: {
        authorization: `Bearer ${token}`, accept: "application/vnd.github+json",
        "user-agent": this.userAgent, "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = scrubSecrets((await response.text()).slice(0, this.config.maxBytes), { [this.config.tokenSecret]: token });
    if (!response.ok) throw new Error(explainGitHub(response.status, text));
    return text ? JSON.parse(text) : {};
  }

  async createRepo(input: { name: string; description?: string | undefined; private: boolean }): Promise<unknown> {
    const body = { name: input.name, description: input.description ?? "", private: input.private, auto_init: true };
    const created = (await this.request("POST", "user/repos", body)) as Record<string, unknown>;
    return { repository: created.full_name, address: created.html_url, private: created.private, defaultBranch: created.default_branch };
  }
  async openPullRequest(input: { repo: string; title: string; body?: string | undefined; base: string; head: string }): Promise<unknown> {
    const payload = { title: input.title, body: input.body ?? "", base: input.base, head: input.head };
    const opened = (await this.request("POST", `repos/${input.repo}/pulls`, payload)) as Record<string, unknown>;
    return { repository: input.repo, number: opened.number, title: opened.title, address: opened.html_url, state: opened.state };
  }
  async listIssues(input: { repo: string; state: "open" | "closed" | "all"; limit: number }): Promise<unknown> {
    const query = new URLSearchParams({ state: input.state, per_page: String(input.limit) });
    const issues = (await this.request("GET", `repos/${input.repo}/issues?${query}`)) as Record<string, unknown>[];
    return {
      repository: input.repo,
      issues: (Array.isArray(issues) ? issues : []).slice(0, input.limit).map((issue) => ({
        number: issue.number, title: String(issue.title ?? "").slice(0, 200), state: issue.state,
        address: issue.html_url, isPullRequest: Boolean(issue.pull_request),
      })),
    };
  }
  async createIssue(input: { repo: string; title: string; body?: string | undefined }): Promise<unknown> {
    const created = (await this.request("POST", `repos/${input.repo}/issues`, { title: input.title, body: input.body ?? "" })) as Record<string, unknown>;
    return { repository: input.repo, number: created.number, title: created.title, address: created.html_url };
  }
}

/** GitHub's HTTP answers in words the owner can act on; the reply body is already scrubbed. */
export function explainGitHub(status: number, text: string): string {
  const detail = (/"message"\s*:\s*"([^"]{0,200})"/.exec(text)?.[1] ?? "").trim();
  if (status === 401) return "GitHub did not accept the token. Save a new personal access token in your secrets.";
  if (status === 403) return `GitHub refused this${detail ? `: ${detail}` : ""}. The token may be missing permission, or you may have made too many requests.`;
  if (status === 404) return "GitHub could not find that repository, or the token cannot see it.";
  if (status === 422) return `GitHub would not accept those details${detail ? `: ${detail}` : ""}.`;
  if (status >= 500) return "GitHub is having trouble right now. Try again shortly.";
  return `GitHub answered ${status}${detail ? `: ${detail}` : ""}.`;
}
