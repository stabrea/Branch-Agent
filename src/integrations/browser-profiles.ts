import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { LockerKeySource } from '../locker.js';

/**
 * Saved sign-ins for the browser. When the owner signs in to a website by hand once, the cookies
 * and site storage that keep them signed in are written to a file beside the private database,
 * encrypted with a key derived from the device's locker key. The assistant never sees the password
 * and never sees the cookie values; it only asks for a sign-in by name.
 */
export const profileNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Saved sign-in names use lowercase letters, digits and dashes');
export interface StorageState { cookies: unknown[]; origins: unknown[] }
export interface ProfileInfo { name: string; savedAt: string; cookies: number; sites: number }
const StateSchema = z.object({
  cookies: z.array(z.unknown()).max(500).default([]),
  origins: z.array(z.unknown()).max(200).default([]),
  savedAt: z.string().optional(),
}).strict();
/** Four megabytes of cookies and site storage is far more than any real sign-in needs. */
const maxStateBytes = 4 * 1024 * 1024;

export class BrowserProfiles {
  private derived: Promise<Buffer> | undefined;
  constructor(private readonly dir: string, private readonly keys: LockerKeySource) {}
  /** A key of its own, derived from the locker key, so profiles and secrets never share one. */
  private key(): Promise<Buffer> {
    return (this.derived ??= this.keys
      .key()
      .then(root => createHmac('sha256', root).update('branch-browser-profiles-v1').digest()));
  }
  private folder(owner: string): string {
    return join(this.dir, createHash('sha256').update(owner).digest('hex').slice(0, 16));
  }
  private file(owner: string, name: string): string {
    return join(this.folder(owner), profileNameSchema.parse(name) + '.bin');
  }
  async save(owner: string, name: string, state: StorageState): Promise<ProfileInfo> {
    const savedAt = new Date().toISOString();
    const plain = Buffer.from(JSON.stringify({ ...state, savedAt }), 'utf8');
    if (plain.byteLength > maxStateBytes) throw new Error('That sign-in holds too much data to save');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', await this.key(), iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    await mkdir(this.folder(owner), { recursive: true, mode: 0o700 });
    await writeFile(this.file(owner, name), Buffer.concat([iv, cipher.getAuthTag(), body]), { mode: 0o600 });
    return describe(name, state, savedAt);
  }
  /** An empty sign-in the owner can fill in later by signing in once. */
  create(owner: string, name: string): Promise<ProfileInfo> {
    return this.save(owner, name, { cookies: [], origins: [] });
  }
  private async decrypt(owner: string, name: string): Promise<z.infer<typeof StateSchema> | null> {
    let raw: Buffer;
    try { raw = await readFile(this.file(owner, name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (raw.byteLength < 29) throw new Error(`The saved sign-in "${name}" is damaged; remove it and sign in again`);
    const decipher = createDecipheriv('aes-256-gcm', await this.key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    try {
      const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
      return StateSchema.parse(JSON.parse(plain));
    } catch { throw new Error(`The saved sign-in "${name}" could not be read; remove it and sign in again`); }
  }
  /** The cookies and site storage of a saved sign-in, ready to hand to a fresh browser window. */
  async load(owner: string, name: string): Promise<StorageState | null> {
    const found = await this.decrypt(owner, name);
    return found && { cookies: found.cookies, origins: found.origins };
  }
  async list(owner: string): Promise<ProfileInfo[]> {
    let names: string[];
    try { names = (await readdir(this.folder(owner))).filter(file => file.endsWith('.bin')).map(file => file.slice(0, -4)); }
    catch { return []; }
    const found: ProfileInfo[] = [];
    for (const name of names.sort().slice(0, 50)) {
      const state = await this.decrypt(owner, name).catch(() => null);
      found.push(state ? describe(name, state, state.savedAt ?? '') : { name, savedAt: '', cookies: 0, sites: 0 });
    }
    return found;
  }
  async remove(owner: string, name: string): Promise<boolean> {
    const file = this.file(owner, name);
    try { await rm(file); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
}
const describe = (name: string, state: StorageState, savedAt: string): ProfileInfo =>
  ({ name, savedAt, cookies: state.cookies.length, sites: state.origins.length });
