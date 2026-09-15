import { writeFile } from 'node:fs/promises';
import { maximumArchiveBytes, parseConversationArchive } from '../session-library.js';
import { maximumMemoryArchiveBytes, parseMemoryArchive } from '../memory.js';

export async function saveConversationExport(
  input: unknown,
  choosePath: () => Promise<string | undefined>,
): Promise<{ saved: boolean }> {
  return saveArchive(input, choosePath, maximumArchiveBytes, parseConversationArchive);
}

export async function saveMemoryExport(
  input: unknown,
  choosePath: () => Promise<string | undefined>,
): Promise<{ saved: boolean }> {
  return saveArchive(input, choosePath, maximumMemoryArchiveBytes, parseMemoryArchive);
}

async function saveArchive(
  input: unknown, choosePath: () => Promise<string | undefined>,
  maximumBytes: number, parse: (input: unknown) => unknown,
): Promise<{ saved: boolean }> {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > maximumBytes)
    throw new Error(`Archive export must be JSON text of at most ${maximumBytes / 1024 / 1024} MiB`);
  const archive = parse(JSON.parse(input));
  const text = JSON.stringify(archive);
  const path = await choosePath();
  if (!path) return { saved: false };
  await writeFile(path, text, { encoding: 'utf8', mode: 0o600 });
  return { saved: true };
}
