/**
 * A minimal, from-scratch DER/X.509 builder for tests only: enough to make a short-lived,
 * self-signed EC certificate with a single Subject Alternative Name URI, the same shape a Sigstore
 * (Fulcio) certificate has where `verifyAttestationBundle` (src/desktop/provenance.ts) reads it.
 * No dependency is added for this — Node's `crypto` module can parse an X.509 certificate
 * (`X509Certificate`) but not issue one, so a real one is built by hand here, one ASN.1 field at a
 * time, and signed with the same private key it is "self-signed" by.
 */
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
function derLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  const bytes = [];
  for (let n = len; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const derSeq = (...items) => tlv(0x30, Buffer.concat(items));
const derSet = (...items) => tlv(0x31, Buffer.concat(items));
const derOid = (bytes) => tlv(0x06, Buffer.from(bytes));
const derUtf8 = (text) => tlv(0x0c, Buffer.from(text, "utf8"));
const derExplicit = (tagNumber, content) => tlv(0xa0 | tagNumber, content);
const derBitString = (bytes) => tlv(0x03, Buffer.concat([Buffer.from([0]), bytes]));
const derUri = (uri) => tlv(0x86, Buffer.from(uri, "ascii")); // GeneralName [6] IMPLICIT IA5String
function derInt(value) {
  let content = Buffer.from([value & 0xff]);
  if (content[0] & 0x80) content = Buffer.concat([Buffer.from([0]), content]);
  return tlv(0x02, content);
}
function derUtcTime(date) {
  const two = (n) => String(n).padStart(2, "0");
  const text = `${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}` +
    `${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, "ascii"));
}

const ecdsaWithSha256 = derSeq(derOid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])); // 1.2.840.10045.4.3.2
const commonName = derOid([0x55, 0x04, 0x03]); // 2.5.4.3
const subjectAltNameOid = derOid([0x55, 0x1d, 0x11]); // 2.5.29.17

/**
 * Builds a self-signed EC (P-256) certificate whose only Subject Alternative Name is `workflowUri`
 * (the shape Fulcio uses to name the exact GitHub Actions job that requested the certificate), and
 * returns it alongside the key pair used both to issue and (in a real bundle) to sign the payload.
 */
export function makeWorkflowCertificate({ workflowUri, notBefore = new Date(Date.now() - 60_000), notAfter = new Date(Date.now() + 600_000), issuerCommonName = "test-fulcio" } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const issuer = derSeq(derSet(derSeq(commonName, derUtf8(issuerCommonName))));
  const subject = derSeq(); // Fulcio certificates carry an empty subject; identity lives in the SAN.
  const validity = derSeq(derUtcTime(notBefore), derUtcTime(notAfter));
  const spki = publicKey.export({ type: "spki", format: "der" }); // already a full SubjectPublicKeyInfo SEQUENCE
  const sanExtension = derSeq(subjectAltNameOid, tlv(0x04, derSeq(derUri(workflowUri))));
  const extensions = derExplicit(3, derSeq(sanExtension));
  const tbsCertificate = derSeq(derExplicit(0, derInt(2)), derInt(1), ecdsaWithSha256, issuer, validity, subject, spki, extensions);
  const signature = cryptoSign("sha256", tbsCertificate, privateKey);
  const certificate = derSeq(tbsCertificate, ecdsaWithSha256, derBitString(signature));
  return { certificateDer: certificate, privateKey, publicKey };
}
