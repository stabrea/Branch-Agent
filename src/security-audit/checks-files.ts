import { check, listed, othersCanReach, roleWords } from "./kit.js";
import { inIcloudDesktop, sharedPlace, syncedService, wholeHome } from "./synced.js";
import type { PathRole, SecurityCheck, SecuritySnapshot, Verdict } from "./types.js";

/** Files and folders: who else can reach them, and where they are kept. */

const linked = (id: string, role: PathRole, severity: "warn" | "info", title: string): SecurityCheck =>
  check(id, "files", severity, title, (snapshot) => {
    const link = snapshot.paths.find((fact) => fact.role === role && fact.kind === "link");
    if (!link) return null;
    return {
      detail: `${capital(roleWords[role])} is a link to somewhere else (${link.path}), so who can reach it depends on a place Branch does not look after.`,
      advice: "Replace the link with a real folder or file on this computer, then start Branch again.",
    };
  });

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

function syncedVerdict(snapshot: SecuritySnapshot, role: PathRole, what: string): Verdict | null {
  const fact = snapshot.paths.find((entry) => entry.role === role && entry.kind !== "missing");
  if (!fact) return null;
  const service = syncedService(fact.path, snapshot.home, snapshot.platform)
    ?? (inIcloudDesktop(fact.path, snapshot.home, snapshot.platform, snapshot.icloudDesktopDocuments) ? "iCloud (Desktop and Documents)" : null);
  if (!service) return null;
  return {
    detail: `${capital(roleWords[role])} is inside ${service}, so ${what} is copied to that service and to your other devices.`,
    advice: role === "data-folder"
      ? "Move it to a folder the service does not copy: set BRANCH_DATA_DIR to it, move the folder there, and start Branch again."
      : "Move it to a folder the service does not copy, and point Branch at the new place.",
  };
}

export const fileChecks: SecurityCheck[] = [
  othersCanReach("files.private-folder-open", ["data-folder"], "read", "warn", "Only you can open Branch's private folder",
    { why: "It holds your conversations, your saved passwords and the keys to them." }),
  othersCanReach("files.private-folder-writable", ["data-folder"], "write", "critical", "Only you can change Branch's private folder",
    { why: "Somebody could replace the database or add a plugin that runs with the assistant's powers." }),
  othersCanReach("files.database-readable", ["database"], "read", "critical", "Only you can read your conversations",
    { why: "Every conversation and note is in it." }),
  othersCanReach("files.database-writable", ["database"], "write", "critical", "Only you can change your conversations and settings",
    { why: "Every setting, including what the assistant may do without asking, is in it." }),
  othersCanReach("files.locker-key-readable", ["locker-key"], "read", "critical", "Only you can read the key to your saved passwords",
    { why: "With it, anybody holding a copy of the database can open every saved password and key." }),
  othersCanReach("files.chatgpt-sign-in-readable", ["chatgpt-sign-in"], "read", "critical", "Only you can read your ChatGPT sign-in",
    { why: "With it, somebody could use your ChatGPT plan as you." }),
  othersCanReach("files.session-key-readable", ["session-token"], "read", "critical", "Only you can read the app's own key",
    { why: "With it, somebody could open Branch and do anything you can." }),
  othersCanReach("files.launch-settings-readable", ["integrations"], "read", "warn", "Only you can read the launch settings file",
    { why: "It names the programs, chat accounts and servers Branch uses." }),
  othersCanReach("files.launch-settings-writable", ["integrations"], "write", "critical", "Only you can change the launch settings file",
    { why: "Somebody could add a program for the assistant to run, or a server for it to talk to." }),
  othersCanReach("files.plugins-folder-writable", ["plugins-folder"], "write", "critical", "Only you can add plugins",
    { why: "A plugin runs with all of the assistant's powers once it is switched on." }),
  othersCanReach("files.plugin-writable", ["plugin-file"], "write", "critical", "Only you can change your plugins",
    { why: "A changed plugin runs the new code the next time Branch starts it." }),
  othersCanReach("files.website-sign-ins-readable", ["browser-profiles"], "read", "critical", "Only you can read your saved website sign-ins",
    { why: "They let the private browser act as you on those sites." }),
  othersCanReach("files.screenshots-readable", ["artifacts"], "read", "warn", "Only you can see screenshots and saved pages",
    { why: "They show whatever was on the pages your tasks opened." }),
  othersCanReach("files.task-files-readable", ["kept"], "read", "info", "Only you can see files your tasks produced", { why: "" }),
  othersCanReach("files.logs-readable", ["logs"], "read", "warn", "Only you can read the background logs",
    { why: "They can mention what the assistant was working on." }),
  othersCanReach("files.update-copies-readable", ["update-backups"], "read", "warn", "Only you can read the copies made before updates",
    { why: "Each is a full copy of your settings and conversations." }),
  othersCanReach("files.diagnostics-readable", ["diagnostics"], "read", "info", "Only you can read diagnostic bundles", { why: "" }),
  othersCanReach("files.program-writable", ["shell-program"], "write", "critical", "Only you can change the programs the assistant may run",
    { fix: false, why: "Somebody could swap one for a program of their own, which the assistant would then run for you." }),
  othersCanReach("files.workspace-writable", ["workspace"], "write", "warn", "Only you can change files in your workspace",
    { fix: false, why: "The assistant reads and acts on what is in it, so somebody could leave instructions there for it." }),
  linked("files.private-folder-link", "data-folder", "warn", "Branch's private folder is a real folder"),
  linked("files.locker-key-link", "locker-key", "warn", "The key to your saved passwords is a real file"),
  linked("files.launch-settings-link", "integrations", "info", "The launch settings file is a real file"),
  check("files.private-folder-synced", "files", "warn", "Branch's private folder is not copied to a cloud service",
    (snapshot) => syncedVerdict(snapshot, "data-folder", "every conversation, saved password and key")),
  check("files.launch-settings-synced", "files", "warn", "The launch settings file is not copied to a cloud service",
    (snapshot) => syncedVerdict(snapshot, "integrations", "the list of programs and accounts Branch uses")),
  check("files.workspace-synced", "files", "info", "Your workspace is not copied to a cloud service",
    (snapshot) => syncedVerdict(snapshot, "workspace", "whatever the assistant writes there")),
  check("files.private-folder-shared-place", "files", "critical", "Branch's private folder is not in a shared place", (snapshot) =>
    sharedPlace(snapshot.dataDir, snapshot.platform) ? {
      detail: `Branch's private folder is in ${snapshot.dataDir}, a place everybody on this computer can write to and that may be emptied without asking.`,
      advice: "Set BRANCH_DATA_DIR to a folder inside your own home folder, move the folder there, and start Branch again.",
    } : null),
  check("files.workspace-whole-home", "files", "warn", "The workspace is a folder of its own, not everything you have", (snapshot) =>
    wholeHome(snapshot.workspace, snapshot.home, snapshot.platform) ? {
      detail: `The workspace is ${snapshot.workspace}, so the assistant can read and change everything in it, including your sign-in keys and other programs' settings.`,
      advice: "Make a folder just for the assistant's work and set BRANCH_WORKSPACE to it.",
    } : null),
  check("files.workspace-key-folders", "files", "warn", "No sign-in keys are inside the workspace", (snapshot) =>
    snapshot.workspaceKeyFolders.length ? {
      detail: `The workspace holds ${listed(snapshot.workspaceKeyFolders)}, which keep keys that sign in to other computers and services. The assistant can read them.`,
      advice: "Move those folders out of the workspace, or point the workspace at a folder that does not hold them.",
    } : null),
];
