import { writeFile } from 'node:fs/promises';
import { maximumArchiveBytes, parseConversationArchive } from '../session-library.js';

export async function saveConversationExport(
  input: unknown,
  choosePath: () => Promise<string | undefined>,
): Promise<{ saved: boolean }> {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > maximumArchiveBytes)
    throw new Error('Conversation export must be JSON text of at most 4 MiB');
  const archive = parseConversationArchive(JSON.parse(input));
  const text = JSON.stringify(archive);
  const path = await choosePath();
  if (!path) return { saved: false };
  await writeFile(path, text, { encoding: 'utf8', mode: 0o600 });
  return { saved: true };
}
