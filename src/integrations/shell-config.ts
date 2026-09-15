import { isAbsolute } from 'node:path';
import { stat } from 'node:fs/promises';
import { z } from 'zod';

const safeKey = z.enum(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ', 'CI', 'NO_COLOR']);
const argument = z.string().max(4000).refine(value => !value.includes('\0'), 'NUL is not permitted');
export const ShellConfigSchema = z.object({
  executables: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/), z.object({
    path: z.string().min(1).max(1000).refine(isAbsolute, 'Executable path must be absolute'),
    args: z.array(argument).max(40).default([]),
  }).strict()).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 16, 'Configure 1-16 executable aliases'),
  inheritEnv: z.array(safeKey).max(12).default(['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']),
  env: z.partialRecord(safeKey, z.string().max(4000).refine(value => !value.includes('\0'))).default({}),
  timeoutMs: z.number().int().min(100).max(120000).default(30000),
  maxOutputBytes: z.number().int().min(256).max(8192).default(8192),
}).strict();
export type ShellConfig = z.infer<typeof ShellConfigSchema>;
export const ShellInputSchema = z.object({
  executable: z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/),
  args: z.array(argument).max(80).default([]),
  cwd: z.string().min(1).max(500).default('.'),
  timeoutMs: z.number().int().min(100).max(120000).optional(),
  /** Names of the active project's secrets to expose to the program as environment variables. */
  secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)).max(8).default([]),
}).strict();
export type ShellInput = z.infer<typeof ShellInputSchema>;

export function shellEnvironment(config: ShellConfig, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // libuv may supply the host PATH on Windows when it is absent; explicitly clear it.
  const result: NodeJS.ProcessEnv = { PATH: '' };
  for (const key of config.inheritEnv) {
    const entry = Object.entries(source).find(([name]) => process.platform === 'win32' ? name.toUpperCase() === key : name === key);
    if (entry?.[1]) result[key] = entry[1];
  }
  return { ...result, ...config.env };
}

export async function validateExecutables(config: ShellConfig): Promise<void> {
  for (const executable of Object.values(config.executables)) {
    if (executable.path.includes('\0') || /\.(cmd|bat)$/i.test(executable.path))
      throw new Error('Configure a native executable; Windows npm may use node.exe with a fixed npm-cli.js argument');
    if (!(await stat(executable.path)).isFile()) throw new Error('Configured executable is not a file');
  }
}
