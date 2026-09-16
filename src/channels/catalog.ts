import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Every team-chat service Branch can talk to through one shared adapter, kept as data in
 * `data/channels.json` rather than as a file of code per service. They all work the same way: the
 * owner pastes an address to send to, the service posts what people write to an address of ours,
 * and something signed or shared proves the post really came from the service.
 *
 * A new service is a new row in that file plus a row in the test table. Nothing in
 * `webhook-chat.ts` knows the name of any service.
 */

/** Where a value comes from when a template is filled in. Values the owner saved, or the message. */
export const templateFields = [
  "webhookUrl", "token", "secret", "apiBase", "chatId", "text", "replyTo", "botName", "timestamp", "sign",
] as const;

const template = z.string().min(1).max(600);
/** A JSON body with `{{...}}` inside its strings. Depth is bounded because it is filled in by hand. */
const jsonTemplate: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string().max(600), z.number(), z.boolean(), z.null(), z.array(jsonTemplate).max(20), z.record(z.string().max(60), jsonTemplate)]));

/** How bytes are turned into a signature: which hash, how it is written down, and what is signed. */
export const SignatureSchema = z.object({
  algorithm: z.enum(["sha1", "sha256"]),
  encoding: z.enum(["hex", "base64"]),
  /** What goes into the hash: the exact body, a timestamp joined to it, or a timestamp and the key. */
  signs: z.enum(["body", "timestamp-body", "timestamp-secret"]),
  /** `base64` means the saved secret is itself base64 and is decoded before it is used as a key. */
  keyEncoding: z.enum(["utf8", "base64"]).default("utf8"),
}).strict();
export type SignatureScheme = z.infer<typeof SignatureSchema>;

/** How a post from the service is proved genuine before a single byte of it is believed. */
export const VerifySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hmac"), header: z.string().min(1).max(64), prefix: z.string().max(16).default(""),
    timestampHeader: z.string().max(64).optional(), toleranceSeconds: z.number().int().min(30).max(3600).default(300),
    scheme: SignatureSchema }).strict(),
  /** A shared word in a header, which is all some services offer. */
  z.object({ kind: z.literal("header-token"), header: z.string().min(1).max(64) }).strict(),
  /** A shared word inside the posted JSON, which is what most outgoing-webhook services send. */
  z.object({ kind: z.literal("body-token"), field: z.string().min(1).max(64) }).strict(),
]);
export type VerifyScheme = z.infer<typeof VerifySchema>;

export const SendSchema = z.object({
  url: template,
  encoding: z.enum(["json", "form"]).default("json"),
  headers: z.record(z.string().min(1).max(64), template).default({}),
  body: z.record(z.string().max(60), jsonTemplate),
  /** Dotted path to the id of the message just sent, when the service answers with one. */
  messageIdPath: z.string().max(120).optional(),
  /** Services that sign the address they are posted to (DingTalk) rather than a header. */
  signQuery: z.object({ param: z.string().min(1).max(32), timestampParam: z.string().min(1).max(32),
    milliseconds: z.boolean().default(true), scheme: SignatureSchema }).strict().optional(),
}).strict();

export const ReceiveSchema = z.object({
  verify: VerifySchema,
  /** Dotted path to an array of events, for services that post several at once (LINE). */
  eventsPath: z.string().max(60).optional(),
  /** Dotted paths, read relative to one event. */
  fields: z.object({
    messageId: z.string().min(1).max(120),
    chatId: z.string().min(1).max(120),
    senderId: z.string().min(1).max(120),
    senderName: z.string().max(120).optional(),
    text: z.string().min(1).max(120),
    chatTitle: z.string().max(120).optional(),
    chatKind: z.string().max(120).optional(),
    /** The kind of event, for services that post joins and reactions down the same address. */
    eventType: z.string().max(120).optional(),
  }).strict(),
  /** The text field holds JSON (Feishu); this names the property inside it that holds the words. */
  textInsideJson: z.string().max(60).optional(),
  /** Values of the `chatKind` field that mean several people; anything else is one person. */
  groupValues: z.array(z.string().max(40)).max(8).default([]),
  /** Used when the service says nothing about how many people are in the chat. */
  defaultChatKind: z.enum(["direct", "group"]).default("group"),
  /** Values of `eventType` worth answering; an empty list answers everything. */
  messageTypes: z.array(z.string().max(60)).max(8).default([]),
  /** The one-off check some services make before they will send anything (Feishu, Zulip). */
  challenge: z.object({ whenField: z.string().min(1).max(60), whenValue: z.string().min(1).max(60),
    echoField: z.string().min(1).max(60),
    /** Where the shared word sits on the check post, when that differs from an ordinary post. */
    tokenField: z.string().max(60).optional() }).strict().optional(),
}).strict();

export const ChannelEntrySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,29}$/),
  name: z.string().min(1).max(60),
  docs: z.string().url().max(300),
  /** What the owner has to find and paste in, in their words. */
  needs: z.array(z.string().min(1).max(120)).min(1).max(6),
  send: SendSchema,
  /** Null for a service that can only be sent to, such as a WeCom group robot. */
  receive: ReceiveSchema.nullable(),
  /** How the bot is written when someone addresses it in a group, with `{{botName}}` inside. */
  mention: z.string().max(60).default("@{{botName}}"),
  maxTextLength: z.number().int().min(200).max(8000),
  /** What the service can carry, for the table the owner reads. */
  can: z.object({ files: z.boolean(), voiceIn: z.boolean(), voiceOut: z.boolean(), buttons: z.boolean() }).strict(),
  note: z.string().min(1).max(400),
}).strict();
export type ChannelEntry = z.infer<typeof ChannelEntrySchema>;

export const ChannelCatalogSchema = z.object({
  version: z.literal(1),
  note: z.string().min(1).max(500),
  services: z.array(ChannelEntrySchema).min(8).max(60),
}).strict();
export type ChannelCatalog = z.infer<typeof ChannelCatalogSchema>;

/** Next to the built program first, then the repository's copy, exactly as providers.json works. */
const bundled = [new URL("../channels.json", import.meta.url), new URL("../../data/channels.json", import.meta.url)];
let loaded: ChannelCatalog | undefined;

/** The list of chat services, read once and checked. A damaged file fails loudly, not quietly. */
export function channelCatalog(): ChannelCatalog {
  if (loaded) return loaded;
  for (const source of bundled) {
    let text: string;
    try { text = readFileSync(source, "utf8"); } catch { continue; }
    return (loaded = ChannelCatalogSchema.parse(JSON.parse(text) as unknown));
  }
  throw new Error("The list of chat services (channels.json) is missing from this installation");
}
/** Replaces the loaded list; tests use this to try a list that is not the shipped one. */
export function useChannelCatalog(catalog: ChannelCatalog | undefined): void { loaded = catalog; }
export function channelEntry(id: string): ChannelEntry | undefined {
  return channelCatalog().services.find((entry) => entry.id === id);
}
export function channelEntries(): ChannelEntry[] { return channelCatalog().services; }

export { readPath, fill, fillJson } from "../json-template.js";
