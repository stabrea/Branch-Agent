/**
 * FQ-operations.portable: which platform/architecture pairs the single-binary build is declared to
 * support. A build refuses to run on anything not on this list, so "launch a packaged binary on a
 * declared supported target" is answered by an actual declaration rather than "whatever happened to
 * work on the machine that built it".
 */
export interface PortableTarget {
  platform: NodeJS.Platform;
  arch: string;
  label: string;
  /** File name suffix the packaged executable gets on this target. */
  binaryExtension: string;
}

const DECLARED_TARGETS: readonly PortableTarget[] = [
  { platform: "win32", arch: "x64", label: "Windows x64", binaryExtension: ".exe" },
  { platform: "win32", arch: "arm64", label: "Windows ARM64", binaryExtension: ".exe" },
  { platform: "darwin", arch: "x64", label: "macOS Intel", binaryExtension: "" },
  { platform: "darwin", arch: "arm64", label: "macOS Apple Silicon", binaryExtension: "" },
  { platform: "linux", arch: "x64", label: "Linux x64", binaryExtension: "" },
  { platform: "linux", arch: "arm64", label: "Linux ARM64", binaryExtension: "" },
];

export function declaredPortableTargets(): readonly PortableTarget[] {
  return DECLARED_TARGETS;
}

export function currentHostTarget(): { platform: NodeJS.Platform; arch: string } {
  return { platform: process.platform, arch: process.arch };
}

/** The declared target that matches a host (this computer, by default), or null when none does. */
export function matchTarget(host: { platform: NodeJS.Platform; arch: string } = currentHostTarget()): PortableTarget | null {
  return DECLARED_TARGETS.find((candidate) => candidate.platform === host.platform && candidate.arch === host.arch) ?? null;
}
