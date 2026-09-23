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
 * repos/cli/cli/attestations/sha256:<digest>`), that URL did not serve plain JSON, in a form this
 * file does not decode. Such a bundle is skipped, the same as one that was never published — never
 * trusted half-read, and never allowed to block an update the checksum already passed.
 */

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

/** A bundle GitHub externalised; read as plain JSON, and quietly skipped when it is not (see above). */
async function fetchExternalBundle(fetchImpl: typeof fetch, url: string, userAgent: string): Promise<AttestationBundle | null> {
  try {
    const response = await fetchImpl(url, { headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return null;
    const parsed = bundleSchema.safeParse(await response.json());
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
