/**
 * Where a chat app's stream of messages was read up to, kept in the saved-work database so that
 * after a restart the messages that arrived in the meantime are fetched and answered — and the ones
 * already answered are not answered twice. A position is saved only after its message was handled,
 * so a message cut off by a crash is fetched again (see docs/never-break.md, threat 3).
 */
export interface ChannelPosition {
  load(): number;
  save(offset: number): void;
}

interface SettingsStore {
  get(table: "settings", owner: string, id: string): { data: Record<string, unknown> } | undefined;
  save(table: "settings", owner: string, id: string, data: Record<string, unknown>): unknown;
}

export function channelPosition(store: unknown, channelId: string, owner = "local"): ChannelPosition | undefined {
  const saved = store as Partial<SettingsStore> | null;
  if (typeof saved?.get !== "function" || typeof saved.save !== "function") return undefined;
  const settings = saved as SettingsStore;
  const key = `channel-position:${channelId}`;
  return {
    load: () => {
      const offset = Number(settings.get("settings", owner, key)?.data.offset ?? 0);
      return Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
    },
    save: (offset) => {
      try { settings.save("settings", owner, key, { offset, savedAt: new Date().toISOString() }); }
      catch { /* a position that is not saved only means a message may be fetched again */ }
    },
  };
}
