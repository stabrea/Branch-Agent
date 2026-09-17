import * as http from "node:http";
import * as tls from "node:tls";
import { X509Certificate } from "node:crypto";
import type { z } from "zod";
import type { ComfortNetworkSchema } from "./settings.js";

/**
 * R17-S20: a proxy and extra trusted certificates, for every call Branch itself makes.
 *
 * Both are applied to the whole program at once (Node's own proxy switch and its default list of
 * trusted certificates), so every outbound call — which the network policy checks first, as ever —
 * goes the same way. The owner's certificates are always added to the ones this computer already
 * trusts; nothing here can replace that list, and nothing here can turn certificate checks off.
 */
export type NetworkChoice = z.infer<typeof ComfortNetworkSchema>;

/** What the program offers for this; handed in so tests never change the real process. */
export interface NetworkHooks {
  setProxy?: ((env: Record<string, string>) => () => void) | undefined;
  defaultCertificates: () => string[];
  setCertificates: (certificates: string[]) => void;
}
export const processNetworkHooks = (): NetworkHooks => ({
  setProxy: typeof (http as { setGlobalProxyFromEnv?: unknown }).setGlobalProxyFromEnv === "function"
    ? (env) => (http as unknown as { setGlobalProxyFromEnv(env: Record<string, string>): () => void }).setGlobalProxyFromEnv(env)
    : undefined,
  defaultCertificates: () => tls.getCACertificates("default"),
  setCertificates: (certificates) => tls.setDefaultCACertificates(certificates),
});

/** Why a proxy address is refused, or null. A password in it is refused: it would be written down. */
export function proxyProblem(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return "Write the proxy as http://host:port or https://host:port."; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http and https proxies can be used.";
  if (url.username || url.password) return "A proxy address cannot carry a user name or password.";
  if (!url.hostname) return "The proxy needs a host name.";
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) return "Give only the proxy's host and port, with nothing after them.";
  return null;
}

/** Checks one PEM certificate: readable, a certificate authority, and not expired. Returns its subject. */
export function checkCertificate(pem: string, now = new Date()): string {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length !== 1) throw new Error("Paste exactly one certificate, from -----BEGIN CERTIFICATE----- to -----END CERTIFICATE-----.");
  if (/PRIVATE KEY/.test(pem)) throw new Error("That text holds a private key. Only paste the certificate.");
  let certificate: X509Certificate;
  try { certificate = new X509Certificate(blocks[0]!); } catch { throw new Error("That certificate could not be read."); }
  if (!certificate.ca) throw new Error("That certificate is not a certificate authority, so it cannot be trusted for other sites.");
  if (new Date(certificate.validTo) < now) throw new Error("That certificate has expired.");
  if (new Date(certificate.validFrom) > now) throw new Error("That certificate is not valid yet.");
  return certificate.subject.replace(/\n/g, ", ").slice(0, 200);
}

/** Refuses anything that is not safe to keep; the settings schema has already checked the shape. */
export function validateNetwork(choice: NetworkChoice, now = new Date()): void {
  if (choice.proxy) {
    const problem = proxyProblem(choice.proxy);
    if (problem) throw new Error(problem);
  }
  const names = new Set<string>();
  for (const entry of choice.caCertificates) {
    if (names.has(entry.name)) throw new Error(`Two certificates are called ${entry.name}. Give each its own name.`);
    names.add(entry.name);
    try { checkCertificate(entry.pem, now); } catch (error) { throw new Error(`${entry.name}: ${(error as Error).message}`); }
  }
}

export interface NetworkState { proxy: "none" | "in use" | "needs a newer Node"; certificates: number }

/**
 * Applies the owner's choice to the running program. The first call remembers the computer's own
 * certificate list, so a later call (or turning everything off) always starts again from it.
 */
export class OutboundNetwork {
  private base: string[] | null = null;
  private undoProxy: (() => void) | null = null;
  state: NetworkState = { proxy: "none", certificates: 0 };
  constructor(private readonly hooks: NetworkHooks = processNetworkHooks()) {}

  apply(choice: NetworkChoice): NetworkState {
    this.applyCertificates(choice);
    this.undoProxy?.();
    this.undoProxy = null;
    let proxy: NetworkState["proxy"] = "none";
    if (choice.proxy && !proxyProblem(choice.proxy)) {
      if (!this.hooks.setProxy) proxy = "needs a newer Node";
      else {
        // Local model servers (Ollama, LM Studio) on this computer never go through the proxy.
        const noProxy = [...new Set(["localhost", "127.0.0.1", "::1", ...choice.noProxy])].join(",");
        this.undoProxy = this.hooks.setProxy({ HTTP_PROXY: choice.proxy, HTTPS_PROXY: choice.proxy, ...(noProxy ? { NO_PROXY: noProxy } : {}) });
        proxy = "in use";
      }
    }
    return (this.state = { proxy, certificates: this.state.certificates });
  }
  private applyCertificates(choice: NetworkChoice): void {
    const usable = choice.caCertificates.filter((entry) => { try { checkCertificate(entry.pem); return true; } catch { return false; } });
    if (!usable.length && this.base === null) { this.state = { ...this.state, certificates: 0 }; return; }
    this.base ??= this.hooks.defaultCertificates();
    this.hooks.setCertificates([...this.base, ...usable.map((entry) => entry.pem.trim())]);
    this.state = { ...this.state, certificates: usable.length };
  }
  /** Puts the program back as it started. */
  reset(): void {
    this.undoProxy?.();
    this.undoProxy = null;
    if (this.base !== null) this.hooks.setCertificates(this.base);
    this.state = { proxy: "none", certificates: 0 };
  }
}
