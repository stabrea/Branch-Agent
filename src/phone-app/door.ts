import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { encodeQr, type QrMatrix } from "../remote/qr.js";
import { isTailnetAddress, type ProbeTailscale, probeTailscale } from "../remote/tailscale.js";
import { homeNetworkAddress } from "./address.js";
import type { PhoneAppFile } from "./file.js";
import { phoneAppDownloadName } from "./file.js";
import { androidPage, iphonePage, isApplePhone, pickLanguage, refusedPage, wordsFor, type Dictionaries } from "./page.js";

/**
 * mac7/phone-qr: the phone download door.
 *
 * A second, separate little web server that exists only while the "Get Branch on your phone" code
 * is showing. It is NOT Branch's door with a check in front: it is its own `createServer` with its
 * own handler, which holds the app file, the page words and one random link, and nothing else, so
 * there is nothing else in Branch it could hand out. It listens on one home network (or Tailscale)
 * address, never on every address and never on a public one, and closes itself when its time is up.
 *
 * What a caller on the same network can reach while the code is showing, with no key at all:
 *   GET/HEAD /get/<link>                    the install page (or the iPhone page)
 *   GET/HEAD /get/<link>/Branch-Agent.apk   the app file (or the iPhone page)
 * Everything else — any other path, method, link, or the right link after it expired — is one
 * identical 404, and after the time is up the port is closed altogether.
 */
export const doorLifetimeMs = 15 * 60_000;
export const apkType = "application/vnd.android.package-archive";

export interface DoorState {
  token: string;
  file: PhoneAppFile;
  /** The app's bytes, checked against its checksum when the code was made; what is sent. */
  bytes: Buffer;
  expiresAt: number;
  dictionaries: Dictionaries;
  now: () => number;
}

/** Headers that stop a browser or file manager guessing the file is something else. */
export function fileHeaders(size: number): Record<string, string> {
  return {
    "Content-Type": apkType,
    "Content-Disposition": `attachment; filename="${phoneAppDownloadName}"`,
    "Content-Length": String(size),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}

const pageHeaders = (length: number): Record<string, string> => ({
  "Content-Type": "text/html; charset=utf-8", "Content-Length": String(length),
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
});

const sameToken = (given: string, token: string): boolean =>
  given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));

/** Which of the two things was asked for, or null for anything at all else. */
export function doorRoute(state: DoorState, method: string | undefined, rawUrl: string | undefined): "page" | "file" | null {
  if (method !== "GET" && method !== "HEAD") return null;
  if (state.now() >= state.expiresAt) return null;
  const match = /^\/get\/([A-Za-z0-9_-]{1,64})(\/Branch-Agent\.apk)?$/.exec((rawUrl ?? "").split("?")[0]!);
  if (!match || !sameToken(match[1]!, state.token)) return null;
  return match[2] ? "file" : "page";
}

function sendPage(request: IncomingMessage, response: ServerResponse, status: number, html: string): void {
  const body = Buffer.from(html);
  response.writeHead(status, pageHeaders(body.length));
  response.end(request.method === "HEAD" ? undefined : body);
}

function sendFile(request: IncomingMessage, response: ServerResponse, bytes: Buffer): void {
  // The bytes checked when the code was made are the bytes sent; the file on disk is not read again.
  response.writeHead(200, fileHeaders(bytes.length));
  response.end(request.method === "HEAD" ? undefined : bytes);
}

/** The whole of what the door does. It is handed nothing it could leak. */
export function doorHandler(state: DoorState) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    const language = pickLanguage(request.headers["accept-language"], Object.keys(state.dictionaries));
    const say = wordsFor(state.dictionaries, language);
    const route = doorRoute(state, request.method, request.url);
    if (!route) return sendPage(request, response, 404, refusedPage(say, language));
    if (isApplePhone(request.headers["user-agent"])) return sendPage(request, response, 200, iphonePage(say, language));
    if (route === "page") return sendPage(request, response, 200, androidPage(say, language, `/get/${state.token}/${phoneAppDownloadName}`, state.file.size));
    sendFile(request, response, state.bytes);
  };
}

export interface DoorView { url: string; address: string; port: number; expiresAt: string; qr: QrMatrix }

/**
 * Only one home network or Tailscale address; never every address, never a public one.
 * A 100.64/10 address is accepted only when Tailscale reports it as this computer's own.
 */
export async function assertDoorAddress(address: string, probe: ProbeTailscale = probeTailscale): Promise<void> {
  if (isIP(address) !== 4)
    throw new Error("The phone download only opens on a home network or Tailscale address.");
  if (homeNetworkAddress(address)) return;
  if (!isTailnetAddress(address))
    throw new Error("The phone download only opens on a home network or Tailscale address.");
  // A 100.64/10 address requires Tailscale verification
  try {
    const status = await probe();
    if (!status.running)
      throw new Error(`Tailscale is not running. The address ${address} is in Tailscale's range but cannot be verified.`);
    if (!status.present)
      throw new Error(`Tailscale is not installed. The address ${address} is in Tailscale's range but cannot be verified.`);
    if (status.address !== address)
      throw new Error(`This address (${address}) is in Tailscale's range but Tailscale does not report it as this computer's own address.`);
  } catch (error) {
    if (error instanceof Error)
      throw error;
    throw new Error(`Tailscale verification failed for ${address}: ${String(error)}`);
  }
}

/** Makes one link on one address. `start` again replaces it; `stop` or the clock closes it. */
export class PhoneDoor {
  private server: Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private current: DoorView | null = null;
  private state: DoorState | null = null;
  constructor(private readonly now: () => number = Date.now) {}
  view(): DoorView | null {
    if (this.current && this.now() >= Date.parse(this.current.expiresAt)) this.stop();
    return this.server ? this.current : null;
  }
  async start(input: { file: PhoneAppFile; bytes: Buffer; address: string; dictionaries: Dictionaries; lifetimeMs?: number; port?: number; tailscale?: ProbeTailscale }): Promise<DoorView> {
    await assertDoorAddress(input.address, input.tailscale);
    this.stop();
    const token = randomBytes(18).toString("base64url");
    const expiresAt = this.now() + (input.lifetimeMs ?? doorLifetimeMs);
    const state: DoorState = { token, file: input.file, bytes: input.bytes, expiresAt, dictionaries: input.dictionaries, now: this.now };
    const server = createServer(doorHandler(state));
    server.headersTimeout = 10_000;
    server.requestTimeout = 10 * 60_000;
    server.maxConnections = 16;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(input.port ?? 0, input.address, () => { server.off("error", reject); resolve(); });
    });
    const port = (server.address() as { port: number }).port;
    const url = `http://${input.address}:${port}/get/${token}`;
    this.server = server; this.state = state;
    this.current = { url, address: input.address, port, expiresAt: new Date(expiresAt).toISOString(), qr: encodeQr(url) };
    this.timer = setTimeout(() => this.stop(), input.lifetimeMs ?? doorLifetimeMs);
    this.timer.unref();
    return this.current;
  }
  /**
   * Closes the port and ends the link at once: any request after this, even on a connection that
   * is still open, gets the same refusal. A download already under way is let finish (at most the
   * request time limit), so a phone that pressed Download a second before the end is not cut off.
   */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.state) this.state.expiresAt = 0;
    const server = this.server;
    this.server = null; this.timer = null; this.current = null; this.state = null;
    if (!server) return;
    // Not awaited: `close` waits for a download under way, and the owner's Stop must answer at once.
    server.close();
    server.closeIdleConnections();
  }
  /** Resolves when the door closes, for `branch phone` to wait on. */
  closed(): Promise<void> {
    const server = this.server;
    return server?.listening ? new Promise((resolve) => server.once("close", () => resolve())) : Promise.resolve();
  }
}
