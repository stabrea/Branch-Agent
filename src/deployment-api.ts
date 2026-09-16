import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import { autostartState, setAutostart } from "./install/autostart.js";
import { daemonCommand, daemonLauncherName, type DaemonAction, type DaemonOptions } from "./install/daemon.js";
import { listUpdateBackups, readFirstStart, readUpdateBackup, writeUpdateBackup } from "./install/update-backup.js";
import { doctorFix } from "./doctor-fix.js";
import type { RemoteAccess } from "./remote/remote-access.js";
import type { QrMatrix } from "./remote/qr.js";
import type { createBranch } from "./index.js";

/**
 * The screens behind "how Branch runs on this computer": start with Windows, keep working with the
 * window closed, reach it from a phone, and the safety copies taken before an update.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;

export interface DeploymentContext {
  dataDir: string;
  workspace: string;
  port: number;
  /** The installed app's own program file, or null when Branch runs from a source checkout. */
  executable: string | null;
  installRoot: string | null;
  remote: RemoteAccess;
}

const EnabledSchema = z.object({ enabled: z.boolean(), minimized: z.boolean().optional() }).strict();
const DaemonSchema = z.object({ action: z.enum(["install", "uninstall", "status"]) }).strict();
const RestoreSchema = z.object({ name: z.string().min(1).max(120) }).strict();

/** The barcode as rows of noughts and ones, which the page paints as squares. */
export function qrRows(matrix: QrMatrix): { size: number; version: number; rows: string[] } {
  return {
    size: matrix.size, version: matrix.version,
    rows: matrix.modules.map((row) => row.map((dark) => (dark ? "1" : "0")).join("")),
  };
}

function daemonOptions(context: DeploymentContext): DaemonOptions {
  if (!context.executable || !context.installRoot)
    throw new Error("Branch has to be installed on this computer before it can keep running in the background.");
  return {
    executable: context.executable,
    script: join(context.installRoot, "resources", "app", "dist", "cli.js"),
    dataDir: context.dataDir, workspace: context.workspace, port: context.port,
    launcherPath: join(context.dataDir, daemonLauncherName),
  };
}

async function overview(app: Branch, context: DeploymentContext): Promise<unknown> {
  const installed = Boolean(context.executable);
  return {
    installed,
    installRoot: context.installRoot,
    dataDir: context.dataDir,
    autostart: installed ? await autostartState() : { enabled: false, minimized: false, command: null },
    daemon: installed
      ? await daemonCommand("status", daemonOptions(context))
      : { action: "status", taskName: "Branch Agent daemon", installed: false, message: "Install Branch on this computer to keep it running with the window closed." },
    remote: context.remote.status(),
    restorePoints: await listUpdateBackups(context.dataDir),
    firstStart: await readFirstStart(context.dataDir),
    version: app.version,
  };
}

async function setRemote(app: Branch, context: DeploymentContext, body: unknown, handler: Parameters<RemoteAccess["enable"]>[0]): Promise<unknown> {
  const { enabled } = EnabledSchema.parse(body);
  return enabled ? context.remote.enable(handler) : context.remote.disable();
}

/** Handles everything under /api/deployment; returns undefined when the path is not one of ours. */
export async function deploymentApi(
  app: Branch, request: IncomingMessage, path: string, context: DeploymentContext,
  readBody: (request: IncomingMessage) => Promise<unknown>,
  remoteHandler: Parameters<RemoteAccess["enable"]>[0],
): Promise<unknown | undefined> {
  if (request.method === "GET" && path === "/api/deployment") return overview(app, context);
  if (request.method === "POST" && path === "/api/deployment/autostart") {
    const { enabled, minimized } = EnabledSchema.parse(await readBody(request));
    if (!context.executable) throw new Error("Branch has to be installed on this computer before it can start with Windows.");
    return setAutostart(enabled, { executable: context.executable, minimized: minimized ?? true });
  }
  if (request.method === "POST" && path === "/api/deployment/daemon") {
    const { action } = DaemonSchema.parse(await readBody(request));
    return daemonCommand(action as DaemonAction, daemonOptions(context));
  }
  if (request.method === "POST" && path === "/api/deployment/remote")
    return setRemote(app, context, await readBody(request), remoteHandler);
  if (request.method === "POST" && path === "/api/deployment/remote/invite") {
    const invitation = context.remote.invite();
    return { url: invitation.url, code: invitation.code, expiresAt: invitation.expiresAt, qr: qrRows(invitation.qr) };
  }
  if (request.method === "GET" && path === "/api/deployment/doctor") {
    const fix = new URL(request.url ?? "/", "http://local").searchParams.get("fix") === "1";
    // Branch itself is listening on that address, so "in use" is the right answer, not a problem.
    return doctorFix({ fix, port: context.port, workspace: context.workspace, portIsOurs: true });
  }
  if (request.method === "POST" && path === "/api/deployment/backup")
    return writeUpdateBackup(context.dataDir, app.store.backup(app.version), app.version);
  if (request.method === "GET" && path === "/api/deployment/restore-points")
    return { points: await listUpdateBackups(context.dataDir), firstStart: await readFirstStart(context.dataDir) };
  if (request.method === "POST" && path === "/api/deployment/restore-point") {
    const { name } = RestoreSchema.parse(await readBody(request));
    const archive = await readUpdateBackup(context.dataDir, name);
    return app.store.restore(archive, { replaceExisting: true });
  }
  return undefined;
}
