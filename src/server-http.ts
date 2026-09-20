import type { IncomingMessage } from "node:http";

/** An HTTP failure whose status is safe to return to the local client. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Read one bounded UTF-8 JSON request body with consistent errors for every API module. */
export async function readJsonBody(request: IncomingMessage, maximumBytes = 65536): Promise<unknown> {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new HttpError(415, "Use application/json");
  const tooLarge = () => new HttpError(413, `Request exceeds ${maximumBytes / 1024} KiB`);
  if (Number(request.headers["content-length"] ?? 0) > maximumBytes) throw tooLarge();
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maximumBytes) throw tooLarge();
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}
