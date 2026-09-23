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
  }),
});
export type AttestationBundle = z.infer<typeof bundleSchema>;
const attestationsResponseSchema = z.object({
  attestations: z.array(z.object({ bundle: bundleSchema })),
});
const inTotoStatementSchema = z.object({
  subject: z.array(z.object({ digest: z.object({ sha256: z.string().optional() }).partial() })).min(1),
});

/** Fetches every build-provenance record GitHub has published for this file's SHA-256, or null when it has none. */
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
  return parsed.data.attestations.map((entry) => entry.bundle);
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
  const now = Date.now();
  if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo))
    throw new Error("the provenance record's signing certificate is not currently valid");

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
