import type { IncomingMessage } from "node:http";
import { HttpError, readJsonBody } from "./server-http.js";
import type { SocialScheduler } from "./social-scheduler.js";

/**
 * FQ-packages.social: the routes for preparing a post, scheduling it, and the owner's yes or no.
 * A post never goes out through these routes alone — only `approve` can send one, and only once it
 * is due (src/social-scheduler.ts carries the actual queue).
 */
export const handlesSocialPath = (path: string): boolean =>
  path === "/api/social/posts" || path.startsWith("/api/social/posts/");

export async function socialApi(
  social: SocialScheduler, owner: string, request: IncomingMessage, path: string,
): Promise<unknown> {
  const method = request.method ?? "GET";
  if (method === "GET" && path === "/api/social/posts") return { posts: social.list(owner) };
  if (method === "POST" && path === "/api/social/posts") return social.prepare(owner, await readJsonBody(request));
  const decision = /^\/api\/social\/posts\/([0-9a-f-]{36})\/(approve|reject)$/.exec(path);
  if (decision && method === "POST")
    return decision[2] === "approve" ? social.approve(owner, decision[1]!) : social.reject(owner, decision[1]!);
  throw new HttpError(404, "Endpoint not found");
}
