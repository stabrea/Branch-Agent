import type { IncomingMessage } from "node:http";
import type { ChannelAdapter } from "./router.js";

/**
 * mac6/bucket-16: chat services that check this computer's address with a GET and then post XML,
 * signing each request in its query string rather than a header (WeChat Official Accounts and WeCom
 * apps). They use the same `/webhooks/chat/<channel id>/<word>` address as every other posted
 * service; the route hands them the method, the query and the exact bytes, and sends back the text
 * they return. Anything they refuse is written into the record and slowed down like any other post.
 */
export interface SignedQueryChannel {
  /** False while the owner has the service switched off. */
  accepting?(): boolean;
  /** Checks the signature, handles the request, and returns the plain text to answer with. */
  receiveSigned(method: string, query: URLSearchParams, raw: Buffer): Promise<string>;
}

/** True for such a channel, whether or not it sits behind its switch. */
export function isSignedQueryChannel(value: unknown): value is ChannelAdapter & SignedQueryChannel {
  if (!value || typeof value !== "object") return false;
  const inner = (value as { inner?: unknown }).inner;
  if (inner && inner !== value && typeof (value as Partial<SignedQueryChannel>).receiveSigned === "function")
    return isSignedQueryChannel(inner);
  return typeof (value as Partial<SignedQueryChannel>).receiveSigned === "function";
}

/** The exact bytes of a request, up to a limit, without reading them as anything. */
export async function readRawBody(request: IncomingMessage, maximumBytes = 256 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk as Buffer);
    if (bytes > maximumBytes) throw new Error(`Request exceeds ${maximumBytes / 1024} KiB`);
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
}
