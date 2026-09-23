import { createVerify, X509Certificate } from "node:crypto";
import { z } from "zod";

/**
 * Build provenance for an update, on top of the SHA-256 match (`Updater`'s own `verify`) and the
 * package identity check (`validateStagedPackage`): whether GitHub's own build-provenance record
 * for the downloaded file names this repository and signs over this exact file.
 *
 * GitHub publishes such a record only once a release workflow asks for one (the
 * `actions/attest-build-provenance` step); Branch's own workflow does not yet, so most releases
 * have none to check. That is answered as "nothing to check", not as a failure: this record adds
 * to the checksum, it does not replace it, so its absence never blocks an update the checksum
 * already passed. A record that is present and does not check out does block the update, the same
 * way a checksum that does not match already does.
 *
 * What this does not do: walk the signing certificate up to Sigstore's own root of trust (Fulcio's
 * CA) or check its inclusion in the Rekor transparency log. Both need the `sigstore` package, a new
 * dependency this change does not add. The certificate here is trusted only as far as GitHub's own
 * API, reached over TLS, is trusted — the same amount of trust the checksum download already needs.
 *
 * GitHub sometimes answers with `bundle_url` (a separate blob address) instead of an inline
 * `bundle`; checked against a real, currently-published release (`gh api
 * repos/cli/cli/attestations/sha256:<digest>`), that URL serves `Content-Type: application/x-snappy`
 * (the address itself ends `.json.sn`) — the raw Snappy block format (a varint uncompressed length,
 * then literal/copy elements; RFC-less but documented at
 * github.com/google/snappy/blob/main/format_description.txt), not a framed stream and not gzip.
 * `decodeSnappy` below reads that shape with no dependency. Anything that is neither plain JSON nor a
 * body `decodeSnappy` can read is skipped, the same as a bundle that was never published — never
 * trusted half-read, and never allowed to block an update the checksum already passed.
 */

/**
 * Decodes the raw Snappy block format (no framing, no CRC): a varint uncompressed length followed by
 * literal and copy elements. Bounds-checked throughout — a malformed or hostile stream (this reads
 * network input) throws rather than over-reading, and every caller treats that throw as "unreadable",
 * the same as bytes that were never Snappy to begin with.
 */
function decodeSnappy(input: Buffer, maxLength = 8 * 1024 * 1024): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let result = 0, shift = 0;
    for (;;) {
      if (pos >= input.length) throw new Error("truncated snappy varint");
      const byte = input[pos]!; pos++;
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 28) throw new Error("snappy varint too long");
    }
    return result >>> 0;
  };
  const uncompressedLength = readVarint();
  if (uncompressedLength > maxLength) throw new Error("snappy uncompressed length too large");
  const out = Buffer.alloc(uncompressedLength);
  let written = 0;
  while (pos < input.length) {
    const tag = input[pos]!;
    const elementType = tag & 0x3;
    if (elementType === 0) {
      let length = (tag >>> 2) + 1;
      pos++;
      if (length > 60) {
        const extraBytes = length - 60;
        if (pos + extraBytes > input.length) throw new Error("truncated snappy literal length");
        let n = 0;
        for (let i = 0; i < extraBytes; i++) n |= input[pos + i]! << (8 * i);
        pos += extraBytes;
        length = (n >>> 0) + 1;
      }
      if (pos + length > input.length) throw new Error("truncated snappy literal");
      if (written + length > out.length) throw new Error("snappy literal overruns declared length");
      input.copy(out, written, pos, pos + length);
      written += length; pos += length;
    } else {
      let length: number, offset: number;
      if (elementType === 1) {
        length = ((tag >>> 2) & 0x7) + 4;
        if (pos + 1 >= input.length) throw new Error("truncated snappy copy");
        offset = ((tag & 0xe0) << 3) | input[pos + 1]!;
        pos += 2;
      } else if (elementType === 2) {
        length = (tag >>> 2) + 1;
        if (pos + 2 >= input.length) throw new Error("truncated snappy copy");
        offset = input.readUInt16LE(pos + 1);
        pos += 3;
      } else {
        length = (tag >>> 2) + 1;
        if (pos + 4 >= input.length) throw new Error("truncated snappy copy");
        offset = input.readUInt32LE(pos + 1);
        pos += 5;
      }
      if (offset === 0 || offset > written) throw new Error("snappy copy offset out of range");
      if (written + length > out.length) throw new Error("snappy copy overruns declared length");
      // Byte-by-byte on purpose: Snappy copies may overlap their own not-yet-finished source run.
      for (let i = 0; i < length; i++) out[written + i] = out[written - offset + i]!;
      written += length;
    }
  }
  if (written !== uncompressedLength) throw new Error("snappy stream shorter than its declared length");
  return out;
}

const certSchema = z.object({ rawBytes: z.string().min(1) });
const bundleSchema = z.object({
  dsseEnvelope: z.object({
    payload: z.string().min(1),
    payloadType: z.string().min(1),
    signatures: z.array(z.object({ sig: z.string().min(1), keyid: z.string().optional() })).min(1),
  }),
  verificationMaterial: z.object({
    certificate: certSchema.optional(),
    x509CertificateChain: z.object({ certificates: z.array(certSchema).min(1) }).optional(),
    /** The Rekor entry the bundle was logged under; its time is what the signing certificate's short validity window is checked against, not the moment Branch happens to check. */
    tlogEntries: z.array(z.object({ integratedTime: z.union([z.string(), z.number()]).optional() })).optional(),
  }),
});
export type AttestationBundle = z.infer<typeof bundleSchema>;
/** A bundle GitHub answered with directly, or only a URL to fetch it from (GitHub externalises some). */
const attestationEntrySchema = z.object({ bundle: bundleSchema.nullable().optional(), bundle_url: z.string().url().optional() });
const attestationsResponseSchema = z.object({ attestations: z.array(attestationEntrySchema) });

const inTotoStatementSchema = z.object({
  subject: z.array(z.object({ digest: z.object({ sha256: z.string().optional() }).partial() })).min(1),
});

/**
 * Fetches every build-provenance record GitHub has published for this file's SHA-256, or null when
 * it has none. GitHub answers some attestations inline and others only as a `bundle_url` to fetch
 * separately (its listed reason is size); either way, a bundle that does not come back as the plain
 * JSON this reads is treated the same as one that was never published — skipped, not trusted, and
 * never allowed to block an update the checksum already passed.
 */
export async function fetchAttestationBundles(input: {
  fetch: typeof fetch; repo: string; digestHex: string; userAgent: string;
}): Promise<AttestationBundle[] | null> {
  const response = await input.fetch(`https://api.github.com/repos/${input.repo}/attestations/sha256:${input.digestHex}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": input.userAgent },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub did not answer about the build provenance record for this download (HTTP ${response.status}).`);
  const parsed = attestationsResponseSchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.attestations.length === 0) return null;
  const bundles: AttestationBundle[] = [];
  for (const entry of parsed.data.attestations) {
    if (entry.bundle) { bundles.push(entry.bundle); continue; }
    if (!entry.bundle_url) continue;
    const fetched = await fetchExternalBundle(input.fetch, entry.bundle_url, input.userAgent);
    if (fetched) bundles.push(fetched);
  }
  return bundles;
}

/**
 * A bundle GitHub externalised: read as plain JSON first, and, when that is not what the body is,
 * as JSON inside a raw-Snappy-compressed body (GitHub's own blob storage serves these as
 * `Content-Type: application/x-snappy`) — either way quietly skipped, never thrown, when neither
 * reading gives valid JSON of this shape (see the file-level comment above).
 */
async function fetchExternalBundle(fetchImpl: typeof fetch, url: string, userAgent: string): Promise<AttestationBundle | null> {
  try {
    const response = await fetchImpl(url, { headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    let json: unknown;
    try { json = JSON.parse(bytes.toString("utf8")); }
    catch {
      try { json = JSON.parse(decodeSnappy(bytes).toString("utf8")); }
      catch { return null; }
    }
    const parsed = bundleSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

/** DSSE's Pre-Authentication Encoding: the exact bytes a bundle's signature is taken over. */
function dssePae(payloadType: string, payload: Buffer): Buffer {
  const type = Buffer.from(payloadType, "utf8");
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${type.length} `, "utf8"), type,
    Buffer.from(` ${payload.length} `, "utf8"), payload,
  ]);
}

export interface ProvenanceExpectation {
  /** "owner/name" — the repository the release belongs to. */
  repo: string;
  /** The downloaded archive's own SHA-256, already checked against the published checksum. */
  digestHex: string;
}
export interface ProvenanceResult {
  /** The workflow identity named in the signing certificate (a GitHub Actions job URL). */
  workflow: string;
}

/**
 * Verifies one build-provenance bundle: its statement is about this exact file, the signature over
 * it checks out against the certificate GitHub returned with it, and that certificate names a
 * workflow in this repository. Throws a plain sentence, safe to show as-is, naming what did not
 * check out; never returns a partial or "probably fine" result.
 */
export function verifyAttestationBundle(bundle: AttestationBundle, expected: ProvenanceExpectation): ProvenanceResult {
  const payload = Buffer.from(bundle.dsseEnvelope.payload, "base64");
  let parsedPayload: unknown;
  try { parsedPayload = JSON.parse(payload.toString("utf8")); }
  catch { throw new Error("the provenance record's statement could not be read"); }
  const statement = inTotoStatementSchema.safeParse(parsedPayload);
  if (!statement.success) throw new Error("the provenance record's statement could not be read");
  if (!statement.data.subject.some((entry) => entry.digest.sha256?.toLowerCase() === expected.digestHex.toLowerCase()))
    throw new Error("the provenance record is for a different file");

  const rawCert = bundle.verificationMaterial.certificate ?? bundle.verificationMaterial.x509CertificateChain?.certificates[0];
  if (!rawCert) throw new Error("the provenance record did not include a signing certificate");
  let cert: X509Certificate;
  try { cert = new X509Certificate(Buffer.from(rawCert.rawBytes, "base64")); }
  catch { throw new Error("the provenance record's signing certificate could not be read"); }
  // Fulcio issues these certificates to be valid for about ten minutes around the moment of
  // signing, not to stay valid afterwards — so what matters is whether the certificate was valid
  // when it signed, not whether it still is now, days or months later. That moment is the Rekor
  // transparency log entry's own timestamp, carried in the bundle for exactly this reason. Without
  // one (an older bundle shape, or none logged) there is nothing to check the window against, so
  // the window is left unchecked rather than compared to the wrong clock.
  const integratedTime = bundle.verificationMaterial.tlogEntries?.[0]?.integratedTime;
  if (integratedTime !== undefined) {
    const signedAt = Number(integratedTime) * 1000;
    if (!Number.isFinite(signedAt) || signedAt < Date.parse(cert.validFrom) || signedAt > Date.parse(cert.validTo))
      throw new Error("the provenance record's signing certificate was not valid when it was signed");
  }

  const names = (cert.subjectAltName ?? "").split(",").map((entry) => entry.trim());
  const workflowPrefix = `URI:https://github.com/${expected.repo}/`;
  const workflowEntry = names.find((entry) => entry.startsWith(workflowPrefix));
  if (!workflowEntry) throw new Error("the provenance record's signing certificate does not name this repository");

  const signature = bundle.dsseEnvelope.signatures[0]!;
  const pae = dssePae(bundle.dsseEnvelope.payloadType, payload);
  let signatureOk: boolean;
  try { signatureOk = createVerify("SHA256").update(pae).verify(cert.publicKey, Buffer.from(signature.sig, "base64")); }
  catch { throw new Error("the provenance record's signature could not be checked"); }
  if (!signatureOk) throw new Error("the provenance record's signature does not check out against its certificate");

  return { workflow: workflowEntry.slice("URI:".length) };
}
