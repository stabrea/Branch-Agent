import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { partSettings, requireAsk } from "./settings.js";

/**
 * The integration-blocks family: a catalogue of steps for other apps — post to Slack, add a Notion
 * page, append a row to a Google Sheet — that a task, a flow's tool step or the owner can use. Each
 * block is one fixed request written here in code: the address, the method and the shape of what is
 * sent are Branch's, and only the named inputs are filled in (escaped for where they go). The key is
 * the owner's named secret, filled in at the moment of the call, and every call follows the owner's
 * network rules. A block does nothing until the owner names the secret it should use.
 */
export interface BlockInput { key: string; label: string; required: boolean }
export interface AppBlock {
  id: string; app: string; name: string; about: string;
  inputs: BlockInput[];
  /** How the key travels: a bearer header, or as part of the address (Telegram, Discord). */
  keyIn: "bearer" | "address";
  build: (input: Record<string, string>, key: string) => { url: string; body: unknown; headers?: Record<string, string> };
}

const text = (key: string, label: string, required = true): BlockInput => ({ key, label, required });
const seg = (value: string): string => encodeURIComponent(value);
const lines = (value: string | undefined): string[] => (value ?? "").split("\n").map((v) => v.trim()).filter(Boolean);

export const appBlocks: readonly AppBlock[] = [
  { id: "slack.post", app: "Slack", name: "Post a message", about: "Posts to a channel as your Slack app.", keyIn: "bearer",
    inputs: [text("channel", "Channel id"), text("text", "Message")],
    build: (i) => ({ url: "https://slack.com/api/chat.postMessage", body: { channel: i.channel, text: i.text } }) },
  { id: "discord.post", app: "Discord", name: "Post through a webhook", about: "Posts to the channel a Discord webhook belongs to; the secret is the webhook's id/token part.", keyIn: "address",
    inputs: [text("content", "Message")],
    build: (i, key) => ({ url: `https://discord.com/api/webhooks/${key.split("/").map(seg).join("/")}`, body: { content: i.content, allowed_mentions: { parse: [] } } }) },
  { id: "telegram.send", app: "Telegram", name: "Send a message", about: "Sends as your bot to one chat.", keyIn: "address",
    inputs: [text("chat", "Chat id"), text("text", "Message")],
    build: (i, key) => ({ url: `https://api.telegram.org/bot${seg(key)}/sendMessage`, body: { chat_id: i.chat, text: i.text } }) },
  { id: "notion.page", app: "Notion", name: "Add a page to a database", about: "Adds a page with a title to a database shared with your integration.", keyIn: "bearer",
    inputs: [text("database", "Database id"), text("title", "Title"), text("titleProperty", "Title column (usually Name)", false)],
    build: (i) => ({ url: "https://api.notion.com/v1/pages", headers: { "notion-version": "2022-06-28" },
      body: { parent: { database_id: i.database }, properties: { [i.titleProperty || "Name"]: { title: [{ text: { content: i.title } }] } } } }) },
  { id: "sheets.append", app: "Google Sheets", name: "Add a row", about: "Adds one row at the end of a range; one value per line.", keyIn: "bearer",
    inputs: [text("spreadsheet", "Spreadsheet id"), text("range", "Sheet and range, like Sheet1!A:C"), text("values", "Values, one per line")],
    build: (i) => ({ url: `https://sheets.googleapis.com/v4/spreadsheets/${seg(i.spreadsheet!)}/values/${seg(i.range!)}:append?valueInputOption=USER_ENTERED`,
      body: { values: [lines(i.values)] } }) },
  { id: "airtable.record", app: "Airtable", name: "Add a record", about: "Adds a record; one field per line as name=value.", keyIn: "bearer",
    inputs: [text("base", "Base id"), text("table", "Table name"), text("fields", "Fields, one name=value per line")],
    build: (i) => ({ url: `https://api.airtable.com/v0/${seg(i.base!)}/${seg(i.table!)}`,
      body: { fields: Object.fromEntries(lines(i.fields).map((line) => [line.split("=")[0]!.trim(), line.slice(line.indexOf("=") + 1).trim()])) } }) },
  { id: "todoist.task", app: "Todoist", name: "Add a task", about: "Adds a task to your Todoist inbox.", keyIn: "bearer",
    inputs: [text("content", "Task"), text("due", "When, in words (tomorrow 9am)", false)],
    build: (i) => ({ url: "https://api.todoist.com/rest/v2/tasks", body: { content: i.content, ...(i.due ? { due_string: i.due } : {}) } }) },
  { id: "hubspot.contact", app: "HubSpot", name: "Add a contact", about: "Adds a contact with an email address and a first name.", keyIn: "bearer",
    inputs: [text("email", "Email address"), text("firstname", "First name", false)],
    build: (i) => ({ url: "https://api.hubapi.com/crm/v3/objects/contacts", body: { properties: { email: i.email, ...(i.firstname ? { firstname: i.firstname } : {}) } } }) },
];

const KeysSchema = z.object({ keys: z.record(z.string(), z.string().trim().min(1).max(80)).default({}) }).strict();
const keysKey = "asks-app-blocks-keys";
export const RunBlockSchema = z.object({
  block: z.string().trim().min(3).max(40),
  inputs: z.record(z.string(), z.string().max(8000)).default({}),
}).strict();

export class AppBlocks {
  constructor(private readonly store: Store, private readonly owner: string, private readonly fetcher: typeof fetch,
    private readonly secret: (name: string) => Promise<string>) {}
  /** Which locker entry each block uses; a block with none cannot run. */
  keys(): Record<string, string> { return partSettings(this.store, this.owner, keysKey, KeysSchema).keys; }
  setKey(block: string, secret: string | null): Record<string, string> {
    if (!appBlocks.some((b) => b.id === block)) throw new Error("There is no block with that id");
    const keys = { ...this.keys() };
    if (secret) keys[block] = z.string().trim().min(1).max(80).parse(secret); else delete keys[block];
    this.store.save("settings", this.owner, keysKey, { keys });
    return keys;
  }
  list(): { id: string; app: string; name: string; about: string; inputs: BlockInput[]; ready: boolean }[] {
    const keys = this.keys();
    return appBlocks.map(({ build: _build, keyIn: _keyIn, ...rest }) => ({ ...rest, ready: Boolean(keys[rest.id]) }));
  }
  async run(input: unknown): Promise<{ block: string; status: number; ok: boolean; answer: unknown }> {
    requireAsk(this.store, this.owner, "app-blocks");
    const { block: id, inputs } = RunBlockSchema.parse(input);
    const block = appBlocks.find((b) => b.id === id);
    if (!block) throw new Error("There is no block with that id");
    const missing = block.inputs.filter((i) => i.required && !inputs[i.key]?.trim()).map((i) => i.label);
    if (missing.length) throw new Error(`${block.name} needs: ${missing.join(", ")}`);
    const secretName = this.keys()[id];
    if (!secretName) throw new Error(`${block.app} has no key yet. Choose which saved secret it uses first.`);
    const key = await this.secret(secretName);
    const known = Object.fromEntries(block.inputs.map((i) => [i.key, inputs[i.key] ?? ""]));
    const request = block.build(known, key);
    const response = await this.fetcher(request.url, {
      method: "POST", signal: AbortSignal.timeout(20000),
      headers: { "content-type": "application/json", ...(block.keyIn === "bearer" ? { authorization: `Bearer ${key}` } : {}), ...request.headers },
      body: JSON.stringify(request.body),
    });
    const raw = await response.text();
    let answer: unknown = raw.slice(0, 2000);
    try { answer = JSON.parse(raw); } catch { /* a plain-text answer is kept as text */ }
    return { block: id, status: response.status, ok: response.ok, answer };
  }
}

export function registerAppBlocks(registry: ToolRegistry, blocks: AppBlocks): void {
  registry.register({
    name: "blocks.list", permission: "blocks.read",
    description: "List the steps for other apps (Slack, Notion, Google Sheets, Airtable, Todoist, HubSpot, Discord, Telegram), what each needs, and whether the owner has given it a key.",
    parameters: z.object({}).strict(), execute: async () => ({ blocks: blocks.list() }),
  });
  registry.register({
    name: "blocks.run", permission: "blocks.run",
    description: "Run one step for another app with the given inputs, using the key the owner chose for it. This sends something to that app.",
    parameters: RunBlockSchema, execute: async (input) => blocks.run(input),
    target: (input) => input.block,
  });
}
