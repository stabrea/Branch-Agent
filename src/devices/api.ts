import { z } from "zod";
import { qrRows } from "../deployment-api.js";
import { encodeQr } from "../remote/qr.js";
import type { Store } from "../store.js";
import { CapabilitySchema, capabilityInfo, capabilities, offeredOn } from "./capabilities.js";
import type { Devices } from "./index.js";
import { pairingBusy, pairingRefused } from "./book.js";
import { pickDevice } from "./tools.js";

/**
 * mac7/nodes: the web side of Devices.
 *
 *   /api/devices/pair, /api/devices/pair/status   a device answering an invitation. No key: the
 *        invitation number and the device's own signature are what is checked, and every try counts.
 *   everything else under /api/devices             the owner's, behind the same key as the window.
 *        A short-lived key may not even read it (src/short-lived-keys.ts), and a household person
 *        is refused by the server's owner check.
 */
export const handlesDevicesPath = (path: string): boolean => path === "/api/devices" || path.startsWith("/api/devices/");
export const openDevicePaths = ["/api/devices/pair", "/api/devices/pair/status"];

export class DevicesHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface DevicesHttpDeps {
  devices: Devices; store: Store; owner: string; method: string;
  readBody: () => Promise<unknown>;
  /** The address a device should dial: the paired door while it is open, otherwise this computer. */
  baseUrl: string;
}

/**
 * A device answering an invitation, or asking how its request went.
 *
 * mac7/channel-leaks: nothing this route says depends on what is on this computer. Every refusal is
 * `pairingRefused`, with the same 403, whether the method was wrong, the body was rubbish, the
 * invitation was not the one on offer, the number was wrong, the five tries were used up, Devices
 * is switched off or the request asked after was never made. The one other answer, 429, is about
 * how fast the caller is going and so says nothing about Branch either.
 */
export async function openDevicesApi(deps: Omit<DevicesHttpDeps, "baseUrl" | "store" | "owner">, path: string, from: string): Promise<unknown> {
  if (deps.method !== "POST") throw new DevicesHttpError(403, pairingRefused);
  const body = await deps.readBody().catch(() => null);
  try {
    if (path === "/api/devices/pair") return deps.devices.book.redeem(body, from);
    const status = body as { requestId?: unknown; signature?: unknown } | null;
    return deps.devices.book.requestStatus(status?.requestId, status?.signature);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === pairingBusy) throw new DevicesHttpError(429, pairingBusy);
    // A body zod would not take, a wrong number and a request nobody made are one answer.
    throw new DevicesHttpError(403, pairingRefused);
  }
}

function overview(deps: DevicesHttpDeps): unknown {
  const { book, hub } = deps.devices;
  return {
    mode: book.mode(),
    invitation: book.invitation(),
    requests: book.requests().filter((request) => request.status === "waiting")
      .map(({ publicKey: _key, ...request }) => request),
    devices: book.devices().map(({ publicKey: _key, ...device }) => ({
      ...device, connected: hub.connected(device.id), canOffer: offeredOn(device.platform),
    })),
    capabilities: capabilities.map((id) => ({ id, label: capabilityInfo[id].label, kind: capabilityInfo[id].kind, platforms: capabilityInfo[id].platforms })),
  };
}

const deviceRoute = /^\/api\/devices\/([a-f0-9]{16})\/(switch|folder|share|rename|revoke)$/;
const requestRoute = /^\/api\/devices\/requests\/([a-f0-9]{32})$/;
const SwitchSchema = z.object({ capability: CapabilitySchema, on: z.boolean() }).strict();
const PickSchema = z.object({ sessionId: z.string().uuid(), deviceId: z.string().regex(/^[a-f0-9]{16}$/).nullable() }).strict();

async function deviceChange(deps: DevicesHttpDeps, id: string, action: string): Promise<unknown> {
  const { book } = deps.devices;
  if (action === "revoke") return { removed: book.revoke(id) };
  const body = (await deps.readBody() ?? {}) as Record<string, unknown>;
  if (action === "switch") { const { capability, on } = SwitchSchema.parse(body); return { device: book.setSwitch(id, capability, on) }; }
  if (action === "folder") return { device: book.setFolder(id, typeof body.folder === "string" && body.folder.trim() ? body.folder : null) };
  if (action === "share") return { device: book.share(id, body.profiles) };
  return { device: book.rename(id, body.name) };
}

/** The owner's routes. Answers undefined for a path it does not know. */
export async function devicesApi(deps: DevicesHttpDeps, path: string): Promise<unknown> {
  const { devices, method } = deps;
  if (path === "/api/devices" && method === "GET") return overview(deps);
  if (method !== "POST") return undefined;
  if (path === "/api/devices/mode") return { mode: devices.setMode(await deps.readBody()) };
  if (path === "/api/devices/invite") {
    const offer = devices.book.invite();
    const link = `${deps.baseUrl.replace(/\/+$/, "")}/devices/pair?offer=${offer.id}`;
    return { ...offer, link, qr: qrRows(encodeQr(link)) };
  }
  if (path === "/api/devices/invite/cancel") { devices.book.cancelInvite(); return { cancelled: true }; }
  if (path === "/api/devices/pick") {
    const { sessionId, deviceId } = PickSchema.parse(await deps.readBody());
    if (deviceId && !devices.book.device(deviceId)) throw new DevicesHttpError(404, "That device is not on the list.");
    pickDevice(deps.store, deps.owner, sessionId, deviceId);
    return { sessionId, deviceId };
  }
  const request = requestRoute.exec(path);
  if (request) {
    const body = z.object({ approve: z.boolean() }).strict().parse(await deps.readBody());
    const { publicKey: _key, ...decided } = devices.book.decide(request[1]!, body.approve);
    return { request: decided };
  }
  const match = deviceRoute.exec(path);
  if (match) return deviceChange(deps, match[1]!, match[2]!);
  return undefined;
}
