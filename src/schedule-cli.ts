import { connect } from "./cli-attach.js";

/** The value after a --flag on the command line, or undefined. */
const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
};

/** `branch schedule add|list|remove` against the engine already running in the background. */
export async function scheduleCommand(dataDir: string): Promise<void> {
  const client = await connect(dataDir);
  const action = process.argv[3] ?? "list", asJson = process.argv.includes("--json");
  if (action === "list") {
    const { schedules } = await client.get<{ schedules: { id: string; data: Record<string, unknown> }[] }>("/api/schedules");
    if (asJson) return void console.log(JSON.stringify({ schedules }, null, 2));
    if (!schedules.length) return void console.log("Nothing is scheduled.");
    for (const row of schedules)
      console.log([row.id, String(row.data.status ?? ""), String(row.data.dueAt ?? ""), String(row.data.prompt ?? "").slice(0, 60)].join("\t"));
    return;
  }
  if (action === "add") {
    const prompt = flag("prompt");
    if (!prompt) throw new Error('Say what to do: branch schedule add --prompt "water the plants" --at 2026-10-01T09:00:00Z');
    const every = flag("every");
    const saved = await client.post<{ id: string }>("/api/schedules", {
      prompt, kind: flag("kind") ?? "task",
      dueAt: new Date(flag("at") ?? Date.now() + 60_000).toISOString(),
      ...(every ? { intervalMs: Number(every) } : {}),
    });
    console.log(asJson ? JSON.stringify(saved) : `Scheduled. Its number is ${saved.id}.`);
    return;
  }
  if (action === "remove") {
    const id = process.argv[4];
    if (!id) throw new Error("Name the schedule: branch schedule remove <id>");
    const done = await client.post<{ removed: boolean }>(`/api/schedules/${id}/remove`, {});
    console.log(asJson ? JSON.stringify(done) : done.removed ? "Removed." : "There is no schedule with that number.");
    return;
  }
  throw new Error('Usage: branch schedule add --prompt "..." [--at <moment>] [--every <ms>] | schedule list | schedule remove <id>');
}
