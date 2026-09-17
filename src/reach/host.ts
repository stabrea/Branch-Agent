import { gitEnvironment, locateGit } from "../integrations/git-run.js";
import type { GitRunner } from "./agent-git.js";
import { gitRunner } from "./agent-git.js";
import { execBackground } from "./background-screen.js";
import type { ReachDeps } from "./index.js";
import { linuxUsbLister, macUsbLister, type UsbLister } from "./usb.js";

/**
 * The real programs R17-I uses on this computer, chosen once. Nothing here runs anything by
 * itself: each runner is only called when its part is switched on and asked to work.
 */
export function platformRunners(platform: NodeJS.Platform = process.platform): Pick<ReachDeps, "platform" | "backgroundExec" | "git" | "usbLister"> {
  const git: GitRunner = async (args, signal) => {
    const path = await locateGit();
    if (!path) return { code: 1, stdout: "", stderr: "git is not installed on this computer." };
    return gitRunner(path, gitEnvironment(process.env, platform))(args, signal);
  };
  const usbLister: UsbLister = platform === "darwin" ? macUsbLister(execBackground) : platform === "linux" ? linuxUsbLister() : async () => [];
  return { platform, backgroundExec: execBackground, git, usbLister };
}
