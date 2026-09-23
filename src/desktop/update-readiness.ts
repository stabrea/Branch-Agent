import { z } from "zod";

const readinessSchema = z.object({
  channel: z.enum(["stable", "beta"]),
  busyTasks: z.number().int().nonnegative(),
});

/** Ask the authenticated local engine, including a joined background engine, before an update. */
export async function updateReadiness(url: string, token: string, call: typeof fetch = fetch) {
  const origin = new URL(url);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/")
    throw new Error("The local engine address is not safe for an update check.");
  const response = await call(`${origin.origin}/api/comfort/update-readiness`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Branch could not confirm that work is idle, so the update is waiting.");
  return readinessSchema.parse(await response.json());
}
