import { z } from "zod";
import { scrubSecrets } from "../locker.js";
import type { NetworkPolicy } from "../network-policy.js";
import type { TrackerIssue } from "./issue-context.js";

/**
 * Reading Jira issues (A0174, after Continue's issue context). Read only. The owner's site is named
 * in the settings ("acme" for acme.atlassian.net, or a full host name for a server of their own);
 * the sign-in is an email address and an API token kept in the locker by name, read at the moment of
 * a call, sent only in the Authorization header, and scrubbed out of anything reported back. Every
 * address is checked against the network rules first, and an issue on another site is never read
 * with this key (see IssueAccess).
 */
export const JiraConfigSchema = z.object({
  site: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$|^[a-z0-9.-]{4,253}\.[a-z]{2,}$/i, "Name the Jira site, such as acme for acme.atlassian.net"),
  emailSecret: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).default("JIRA_EMAIL"),
  tokenSecret: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).default("JIRA_API_TOKEN"),
  timeoutMs: z.number().int().min(1000).max(60000).default(20000),
  maxBytes: z.number().int().min(4096).max(1048576).default(262144),
}).strict();
export type JiraConfig = z.infer<typeof JiraConfigSchema>;
const issueKey = /^[A-Z][A-Z0-9_]{1,9}-\d{1,7}$/;

export class JiraAccess {
  private readonly config: JiraConfig;
  constructor(input: unknown, private readonly policy: NetworkPolicy, private readonly secret: (name: string) => Promise<string>,
    private readonly fetchImpl: typeof fetch = globalThis.fetch, private readonly userAgent = "BranchAgent") {
    this.config = JiraConfigSchema.parse(input);
  }
  /** The host this key belongs to. */
  get site(): string {
    const site = this.config.site.toLowerCase();
    return site.includes(".") ? site : `${site}.atlassian.net`;
  }

  private async request(path: string): Promise<unknown> {
    const email = await this.secret(this.config.emailSecret).catch(() => "");
    const token = await this.secret(this.config.tokenSecret).catch(() => "");
    if (!email || !token)
      throw new Error(`Connect Jira first: save your Jira email as ${this.config.emailSecret} and an API token as ${this.config.tokenSecret}.`);
    const url = new URL(`rest/api/3/${path}`, `https://${this.site}/`);
    await this.policy.assertAllowed(url, "Jira address");
    const response = await this.fetchImpl(url, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(this.config.timeoutMs),
      headers: { authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`, accept: "application/json", "user-agent": this.userAgent },
    });
    const text = scrubSecrets((await response.text()).slice(0, this.config.maxBytes), { [this.config.tokenSecret]: token });
    if (!response.ok) throw new Error(explainJira(response.status, text));
    try { return text ? JSON.parse(text) : {}; } catch { throw new Error("Jira answered with something that is not an issue."); }
  }

  /** One issue with its comments, in the shape every tracker answers in. */
  async getIssue(input: { key: string }): Promise<TrackerIssue> {
    if (!issueKey.test(input.key)) throw new Error("A Jira issue is named like ABC-123.");
    const issue = (await this.request(`issue/${input.key}?fields=summary,description,status,comment`)) as {
      key?: unknown; fields?: { summary?: unknown; description?: unknown; status?: { name?: unknown }; comment?: { comments?: Record<string, unknown>[] } };
    };
    const fields = issue.fields ?? {};
    return {
      tracker: "jira", reference: String(issue.key ?? input.key),
      title: String(fields.summary ?? "").slice(0, 300),
      body: plainText(fields.description).slice(0, 20000),
      state: String(fields.status?.name ?? ""),
      address: `https://${this.site}/browse/${input.key}`,
      comments: (fields.comment?.comments ?? []).slice(0, 20).map((comment) => ({
        author: String((comment.author as { displayName?: unknown } | undefined)?.displayName ?? "someone").slice(0, 100),
        at: String(comment.created ?? ""),
        body: plainText(comment.body).slice(0, 4000),
      })),
    };
  }
}

/** Jira's rich text (Atlassian Document Format) as plain text: the words, a line per paragraph. */
export function plainText(value: unknown, depth = 0): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || depth > 30) return "";
  const node = value as { type?: unknown; text?: unknown; content?: unknown };
  if (typeof node.text === "string") return node.text;
  const children = Array.isArray(node.content) ? node.content.map((child) => plainText(child, depth + 1)) : [];
  const block = ["paragraph", "heading", "listItem", "codeBlock", "blockquote"].includes(String(node.type));
  return children.join("") + (block ? "\n" : "");
}

/** Jira's answers in words the owner can act on. */
export function explainJira(status: number, text: string): string {
  const detail = (/"errorMessages"\s*:\s*\[\s*"([^"]{0,200})"/.exec(text)?.[1] ?? "").trim();
  if (status === 401) return "Jira did not accept the email and API token. Save them again in your secrets.";
  if (status === 403) return `Jira refused${detail ? `: ${detail}` : ""}.`;
  if (status === 404) return "Jira could not find that issue, or you cannot see it.";
  if (status >= 500) return "Jira is having trouble right now. Try again shortly.";
  return `Jira answered ${status}${detail ? `: ${detail}` : ""}.`;
}
