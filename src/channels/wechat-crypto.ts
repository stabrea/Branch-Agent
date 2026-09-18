import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { sameSecret } from "./parity-common.js";

/**
 * mac6/bucket-16: the message signing and encryption WeChat Official Accounts and WeCom apps share
 * ("safe mode", WXBizMsgCrypt), written from their published descriptions:
 * https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Message_encryption_and_decryption_instructions.html
 * https://developer.work.weixin.qq.com/document/path/90968
 *
 * The signature is SHA-1 over the token, timestamp, nonce and (for a message) the encrypted text,
 * sorted and joined. The key is the 43-character EncodingAESKey read as base64; AES-256-CBC with the
 * key's first 16 bytes as the IV and PKCS#7 padding to 32-byte blocks. Inside: 16 random bytes, the
 * message length (4 bytes, big-endian), the message, then the app or company id it was meant for.
 */
export function wechatSignature(parts: string[]): string {
  return createHash("sha1").update([...parts].sort().join("")).digest("hex");
}

/** True when `supplied` is the signature of `parts`, compared without leaking how much matched. */
export function signatureMatches(supplied: string, parts: string[]): boolean {
  return /^[a-f0-9]{40}$/i.test(supplied) && sameSecret(supplied.toLowerCase(), wechatSignature(parts));
}

function aesKey(encodingAesKey: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}$/.test(encodingAesKey)) throw new Error("The EncodingAESKey must be the 43 characters WeChat shows");
  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  if (key.length !== 32) throw new Error("The EncodingAESKey must be the 43 characters WeChat shows");
  return key;
}

/** Opens one encrypted message and checks it was meant for `receiveId` (the app id or company id). */
export function decryptWechat(encodingAesKey: string, encrypted: string, receiveId: string): string {
  const key = aesKey(encodingAesKey);
  const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  let plain: Buffer;
  try { plain = Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]); }
  catch { throw new Error("The message could not be opened with the saved EncodingAESKey"); }
  const pad = plain.at(-1) ?? 0;
  // mac6/bucket-16 integration: every padding byte is checked, not only the last one.
  if (pad < 1 || pad > 32 || plain.length < 20 + pad || !plain.subarray(plain.length - pad).every((byte) => byte === pad))
    throw new Error("The message could not be opened with the saved EncodingAESKey");
  const body = plain.subarray(16, plain.length - pad);
  const length = body.readUInt32BE(0);
  if (length > body.length - 4) throw new Error("The message could not be opened with the saved EncodingAESKey");
  const from = body.subarray(4 + length).toString("utf8");
  if (from !== receiveId) throw new Error("The message was meant for a different app");
  return body.subarray(4, 4 + length).toString("utf8");
}

/** The reverse, used by the tests' stand-in and for any reply that must be encrypted. */
export function encryptWechat(encodingAesKey: string, message: string, receiveId: string): string {
  const key = aesKey(encodingAesKey);
  const text = Buffer.from(message, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(text.length);
  const body = Buffer.concat([randomBytes(16), length, text, Buffer.from(receiveId, "utf8")]);
  const pad = 32 - (body.length % 32);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([body, Buffer.alloc(pad, pad)])), cipher.final()]).toString("base64");
}

/**
 * Reads the flat `<xml>` WeChat and WeCom post: each child element's text, CDATA or not. It is not a
 * general XML parser and does not try to be one: the first element of each name wins wherever it sits, and a document that
 * declares a DOCTYPE or an entity is refused outright.
 */
/** WeChat's posts are a few kilobytes; the cap keeps the reader quick on anything unsigned. */
export const wechatXmlLimit = 64 * 1024;
export function xmlFields(xml: string): Record<string, string> {
  if (xml.length > wechatXmlLimit || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("That message is not the XML WeChat sends");
  const root = /^\s*(?:<\?xml[^>]*\?>\s*)?<xml>([\s\S]*)<\/xml>\s*$/.exec(xml);
  if (!root) throw new Error("That message is not the XML WeChat sends");
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  const child = /<([A-Za-z][\w]{0,40})>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g;
  for (let match = child.exec(root[1]!); match; match = child.exec(root[1]!)) {
    const name = match[1]!;
    if (name in fields) continue;
    fields[name] = match[2] ?? decodeEntities(match[3] ?? "");
  }
  return fields;
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };
  return text.replace(/&(lt|gt|amp|quot|apos);/g, (_all, name: string) => named[name]!);
}
