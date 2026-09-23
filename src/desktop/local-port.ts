import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

/**
 * Q45 leaf 0 (interim): the window's page keeps some choices in its own storage, which belongs to its address,
 * and the desktop app used to take a new random port every time it started, so after every restart and update
 * those choices were gone. The app now remembers its port and asks for it again when it is free. This is not the
 * whole fix (a taken port, or a background engine on another port, still means a new address): that is Q45's
 * durable preferences. Tests keep port 0.
 */
export async function rememberedPort(path: string, isFree: (port: number) => Promise<boolean> = portIsFree): Promise<number> {
  let port: unknown;
  try { port = JSON.parse(readFileSync(path, "utf8"))?.port; } catch { return 0; }
  if (!Number.isInteger(port) || (port as number) < 1024 || (port as number) > 65535) return 0;
  return (await isFree(port as number)) ? (port as number) : 0;
}

export function rememberPort(path: string, url: string): void {
  const port = Number(new URL(url).port);
  if (!Number.isInteger(port) || port < 1024) return;
  try {
    writeFileSync(`${path}.tmp`, JSON.stringify({ port }));
    renameSync(`${path}.tmp`, path);
  } catch {
    // Remembering the port is a comfort; failing to write it never stops Branch.
  }
}

/** Whether this computer's own address can take the port right now. */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}
