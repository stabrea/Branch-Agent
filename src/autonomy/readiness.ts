import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { z } from "zod";

/**
 * R17-020: what a package says it needs — programs, keys, which systems it runs on, and how to
 * install what is missing on each — and a check of whether this computer has it.
 *
 * The check only looks. A program is looked for in the folders on PATH (no program is started);
 * a key is looked for by name among the owner's secrets and the environment (its value is never
 * read). An install line is shown to the owner as words and never run.
 *
 * A skill declares its needs in its frontmatter `metadata`, either Branch's flat keys
 * (`requires-bins: "gh, jq"`, `requires-any-bins`, `requires-keys`, `os: "darwin, linux"`,
 * `install-brew: "gh"`, `install-apt`, `install-winget`, `install-npm`, `install-pip`) or OpenClaw's
 * JSON block under `openclaw`. Add-on packages (bucket 15) describe their needs in words through
 * `needsOf` in src/add-ons/package-shelf.ts; a package that carries this shape can be checked the same way.
 *
 * The declaration follows OpenClaw's `src/skills/types.ts` and `src/shared/requirements.ts` (MIT) and
 * OpenFang's Hands requirements (`crates/openfang-hands`, MIT/Apache-2.0); the code is Branch's own.
 */
const name = z.string().trim().regex(/^[A-Za-z0-9._+-]{1,64}$/);
const osName = z.string().trim().toLowerCase().transform((v) => (v === "macos" ? "darwin" : v === "windows" ? "win32" : v))
  .pipe(z.enum(["darwin", "linux", "win32"]));
export const installKinds = ["brew", "apt", "winget", "npm", "pip"] as const;
const InstallSchema = z.object({
  kind: z.enum(installKinds),
  package: z.string().trim().regex(/^[A-Za-z0-9@/._+-]{1,120}$/),
  bins: z.array(name).max(16).default([]),
}).strict();
export const NeedsSchema = z.object({
  bins: z.array(name).max(16).default([]),
  anyBins: z.array(name).max(16).default([]),
  keys: z.array(z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/)).max(16).default([]),
  os: z.array(osName).max(3).default([]),
  install: z.array(InstallSchema).max(12).default([]),
}).strict();
export type Needs = z.infer<typeof NeedsSchema>;

export interface Probe {
  platform: NodeJS.Platform;
  /** Whether a file that can be run is at this path. */
  runnable: (path: string) => boolean;
  path: string;
  /** Whether a key of this name is kept (a secret, or set in the environment). Never its value. */
  hasKey: (key: string) => boolean;
}

export interface Missing { kind: "program" | "any-program" | "key" | "system"; name: string; fix: string }
export interface Readiness { ready: boolean; missing: Missing[] }

/** The probe for this computer: PATH folders and file modes only. */
export function localProbe(hasKey: (key: string) => boolean, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Probe {
  return {
    platform, path: env.PATH ?? env.Path ?? "", hasKey: (key) => hasKey(key) || !!env[key],
    runnable: (file) => {
      try { return statSync(file).isFile() && (platform === "win32" || (accessSync(file, constants.X_OK), true)); } catch { return false; }
    },
  };
}

export function findProgram(program: string, probe: Probe): boolean {
  const windows = probe.platform === "win32";
  const ends = windows ? ["", ".exe", ".cmd", ".bat"] : [""];
  const split = windows ? ";" : ":";
  // The folder is joined the way the system being asked about writes paths, not the way this
  // computer does. Reading a Linux PATH on Windows with the host's join turned /usr/bin into
  // \usr\bin and every program on it looked missing.
  const join = windows ? win32.join : posix.join;
  return probe.path.split(split).filter(Boolean).some((folder) => ends.some((end) => probe.runnable(join(folder, program + end))));
}

const installOn: Record<(typeof installKinds)[number], NodeJS.Platform[] | "any"> = { brew: ["darwin", "linux"], apt: ["linux"], winget: ["win32"], npm: "any", pip: "any" };
const command: Record<(typeof installKinds)[number], (pkg: string) => string> = {
  brew: (p) => `brew install ${p}`, apt: (p) => `sudo apt install ${p}`, winget: (p) => `winget install ${p}`,
  npm: (p) => `npm install -g ${p}`, pip: (p) => `pip install ${p}`,
};

function programFix(program: string, needs: Needs, platform: NodeJS.Platform): string {
  const ways = needs.install.filter((spec) => (installOn[spec.kind] === "any" || (installOn[spec.kind] as NodeJS.Platform[]).includes(platform))
    && (!spec.bins.length || spec.bins.includes(program)));
  if (!ways.length) return `Install ${program} and make sure it is on your PATH.`;
  return `Install it yourself with: ${ways.map((spec) => command[spec.kind](spec.package)).join(" or ")}`;
}

/** What is missing on this computer for these needs; `ready` when nothing required is. */
export function checkReadiness(input: unknown, probe: Probe): Readiness {
  const needs = NeedsSchema.parse(input);
  const missing: Missing[] = [];
  if (needs.os.length && !needs.os.includes(probe.platform as Needs["os"][number]))
    missing.push({ kind: "system", name: probe.platform, fix: `It only runs on ${needs.os.join(", ")}.` });
  for (const program of needs.bins)
    if (!findProgram(program, probe)) missing.push({ kind: "program", name: program, fix: programFix(program, needs, probe.platform) });
  if (needs.anyBins.length && !needs.anyBins.some((program) => findProgram(program, probe)))
    missing.push({ kind: "any-program", name: needs.anyBins.join(" or "), fix: `Install one of ${needs.anyBins.join(", ")}.` });
  for (const key of needs.keys)
    if (!probe.hasKey(key)) missing.push({ kind: "key", name: key, fix: `Add a secret called ${key} in Settings, Secrets.` });
  return { ready: missing.length === 0, missing };
}

const list = (value: string | undefined): string[] => (value ?? "").split(/[,\s]+/).map((v) => v.trim()).filter(Boolean);

function fromOpenClaw(raw: string): Partial<Needs> {
  const parsed = JSON.parse(raw) as { requires?: { bins?: string[]; anyBins?: string[]; env?: string[] }; os?: string[];
    install?: { kind?: string; formula?: string; package?: string; bins?: string[] }[] };
  const install = (parsed.install ?? []).flatMap((spec) => {
    const kind = spec.kind === "node" ? "npm" : spec.kind === "uv" ? "pip" : spec.kind;
    const pkg = spec.formula ?? spec.package;
    return kind && pkg && (installKinds as readonly string[]).includes(kind) ? [{ kind, package: pkg, bins: spec.bins ?? [] }] : [];
  });
  return { bins: parsed.requires?.bins ?? [], anyBins: parsed.requires?.anyBins ?? [], keys: parsed.requires?.env ?? [], os: parsed.os ?? [], install } as Partial<Needs>;
}

/** A skill's needs from its frontmatter metadata; null when it declares none. Throws on a malformed declaration. */
export function needsFromMetadata(metadata: Record<string, string> | undefined): Needs | null {
  if (!metadata) return null;
  const flat = {
    bins: list(metadata["requires-bins"]), anyBins: list(metadata["requires-any-bins"]),
    keys: [...list(metadata["requires-keys"]), ...list(metadata["requires-env"])], os: list(metadata.os),
    install: installKinds.flatMap((kind) => list(metadata[`install-${kind}`]).map((pkg) => ({ kind, package: pkg, bins: [] }))),
  };
  const claw = metadata.openclaw ? fromOpenClaw(metadata.openclaw) : {};
  const merged = Object.fromEntries(Object.entries(flat).map(([k, v]) => [k, [...v, ...((claw as Record<string, unknown[]>)[k] ?? [])]]));
  const needs = NeedsSchema.parse(merged);
  const declared = needs.bins.length + needs.anyBins.length + needs.keys.length + needs.os.length;
  return declared ? needs : null;
}
