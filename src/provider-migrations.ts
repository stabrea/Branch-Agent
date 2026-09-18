import { agentModelFor } from "./providers/perplexity-agent.js";

/**
 * Keeping saved connections working when a service moves. Each rule looks at one written-down
 * connection and returns it changed, or unchanged when the rule does not apply; running the rules
 * twice changes nothing more. The connection's id is never changed, because its key is kept in the
 * locker under a name made from that id.
 */
export interface MigratableRecord {
  id: string;
  name: string;
  catalogId: string;
  model: string;
  extras: Record<string, string>;
}

/**
 * Regions that became a choice. A connection saved before there was a choice was talking to the
 * mainland China address, so it keeps talking to it; only new connections start international.
 */
const chinaHosts: Record<string, string> = {
  moonshot: "api.moonshot.cn",
  dashscope: "dashscope.aliyuncs.com",
  // Branch used api.minimax.chat, MiniMax's older mainland address; api.minimax.cn is its current one.
  minimax: "api.minimax.cn",
};

function keepRegion(record: MigratableRecord): MigratableRecord {
  const host = chinaHosts[record.catalogId];
  if (!host || record.extras.host) return record;
  return { ...record, extras: { ...record.extras, host } };
}

/** Perplexity ends its Sonar route on 27 September 2026; Sonar names become Agent API presets. */
function perplexityAgent(record: MigratableRecord): MigratableRecord {
  if (record.catalogId !== "perplexity") return record;
  const model = agentModelFor(record.model);
  return model === record.model ? record : { ...record, model };
}

const rules = [perplexityAgent, keepRegion];

/** Every rule applied to one record. */
export function migrateRecord<T extends MigratableRecord>(record: T): T {
  return rules.reduce((current, rule) => rule(current) as T, record);
}

/**
 * What changed, in words for the record: the service, the old and new model or address. Only
 * catalog ids, model names and host names appear here; a key never does, since records hold none.
 */
export function describeMove(before: MigratableRecord[], after: MigratableRecord[]): string[] {
  return after.flatMap((record, index) => {
    const old = before[index];
    if (!old || JSON.stringify(old) === JSON.stringify(record)) return [];
    const said: string[] = [];
    if (old.model !== record.model) said.push(`model ${old.model} → ${record.model}`);
    if (old.extras.host !== record.extras.host) said.push(`address kept at ${record.extras.host ?? "the default"}`);
    return [`${record.id} (${record.catalogId}): ${said.join(", ")}`];
  });
}

/** The whole list, with the ids of the records that changed so the caller can write it back once. */
export function migrateRecords<T extends MigratableRecord>(records: T[]): { records: T[]; changed: string[] } {
  const changed: string[] = [];
  const next = records.map((record) => {
    const moved = migrateRecord(record);
    if (JSON.stringify(moved) !== JSON.stringify(record)) changed.push(record.id);
    return moved;
  });
  return { records: next, changed };
}
