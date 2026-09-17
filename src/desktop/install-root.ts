import { installTarget } from "./release-assets.js";

/**
 * Where this copy of Branch is installed, worked out one way for everything that needs it (the
 * background engine and the updater): the program's folder on Windows and Linux, the `.app` bundle
 * on a Mac. Null when Branch runs from its source code, or when a Mac copy is not inside an app bundle.
 */
export function installedAppRoot(packaged: boolean, platform: NodeJS.Platform, executablePath: string): string | null {
  return packaged ? installTarget(platform, executablePath) : null;
}
