import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, sign as cryptoSign } from "node:crypto";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { discardTemp } from "./temp-dir.mjs";
import { makeWorkflowCertificate } from "./helpers-provenance-cert.mjs";
import { fetchAttestationBundles, verifyAttestationBundle } from "../dist/desktop/provenance.js";
import { Updater } from "../dist/desktop/updater.js";

const run = promisify(execFile);
const windows = process.platform === "win32";
const repo = "stabrea/Branch-Agent";
const workflowUri = `https://github.com/${repo}/.github/workflows/release.yml@refs/heads/main`;

/** DSSE Pre-Authentication Encoding, built the same way `src/desktop/provenance.ts` builds it. */
function dssePae(payloadType, payload) {
  const type = Buffer.from(payloadType, "utf8");
  return Buffer.concat([Buffer.from(`DSSEv1 ${type.length} `, "utf8"), type, Buffer.from(` ${payload.length} `, "utf8"), payload]);
}

/**
 * A real, signed Sigstore-shaped bundle for `digestHex`, issued by a freshly made test certificate.
 * `integratedTime` (unix seconds) is the moment the transparency log says the bundle was signed,
 * the same field the real world uses to check a short-lived certificate's window; it defaults to a
 * moment inside that window, matching how a genuine bundle always looks.
 */
function makeBundle(digestHex, { uri = workflowUri, notBefore, notAfter, integratedTime } = {}) {
  const window = { notBefore: notBefore ?? new Date(Date.now() - 60_000), notAfter: notAfter ?? new Date(Date.now() + 600_000) };
  const { certificateDer, privateKey } = makeWorkflowCertificate({ workflowUri: uri, ...window });
  const signedAt = integratedTime ?? Math.floor((window.notBefore.getTime() + window.notAfter.getTime()) / 2 / 1000);
  const payloadType = "application/vnd.in-toto+json";
  const payload = Buffer.from(JSON.stringify({
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "Branch-Agent-windows-x64.zip", digest: { sha256: digestHex } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {},
  }), "utf8");
  const signature = cryptoSign("sha256", dssePae(payloadType, payload), privateKey);
  return {
    dsseEnvelope: { payload: payload.toString("base64"), payloadType, signatures: [{ sig: signature.toString("base64"), keyid: "" }] },
    verificationMaterial: {
      certificate: { rawBytes: certificateDer.toString("base64") },
      tlogEntries: [{ integratedTime: String(signedAt) }],
    },
  };
}

test("verifyAttestationBundle accepts a real bundle for this file and this repository", () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const result = verifyAttestationBundle(makeBundle(digestHex), { repo, digestHex });
  assert.equal(result.workflow, workflowUri);
});

test("verifyAttestationBundle refuses a bundle for a different file", () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const otherDigest = createHash("sha256").update("different bytes").digest("hex");
  assert.throws(() => verifyAttestationBundle(makeBundle(otherDigest), { repo, digestHex }), /different file/);
});

test("verifyAttestationBundle refuses a certificate naming a different repository", () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const bundle = makeBundle(digestHex, { uri: "https://github.com/someone-else/Fork/.github/workflows/release.yml@refs/heads/main" });
  assert.throws(() => verifyAttestationBundle(bundle, { repo, digestHex }), /does not name this repository/);
});

test("verifyAttestationBundle refuses a tampered signature", () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const bundle = makeBundle(digestHex);
  const sig = Buffer.from(bundle.dsseEnvelope.signatures[0].sig, "base64");
  sig[sig.length - 1] ^= 0xff; // flip a bit in the signature itself
  bundle.dsseEnvelope.signatures[0].sig = sig.toString("base64");
  assert.throws(() => verifyAttestationBundle(bundle, { repo, digestHex }), /signature does not check out/);
});

test("verifyAttestationBundle accepts a certificate that has since expired, as long as it was valid when the log says it signed", () => {
  // Fulcio certificates are only ever valid for about ten minutes; every real, months-old release
  // is checked long after its certificate's window has passed. What must hold is that the window
  // covered the moment in the transparency log, not that it still covers right now.
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const bundle = makeBundle(digestHex, {
    notBefore: new Date("2026-01-01T00:00:00Z"), notAfter: new Date("2026-01-01T00:10:00Z"),
    integratedTime: Math.floor(new Date("2026-01-01T00:05:00Z").getTime() / 1000),
  });
  const result = verifyAttestationBundle(bundle, { repo, digestHex });
  assert.equal(result.workflow, workflowUri);
});

test("verifyAttestationBundle refuses a certificate that was not valid at the log's signing time", () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const bundle = makeBundle(digestHex, {
    notBefore: new Date("2026-01-01T00:00:00Z"), notAfter: new Date("2026-01-01T00:10:00Z"),
    integratedTime: Math.floor(new Date("2026-01-02T00:00:00Z").getTime() / 1000), // a day after the window closed
  });
  assert.throws(() => verifyAttestationBundle(bundle, { repo, digestHex }), /not valid when it was signed/);
});

test("verifyAttestationBundle skips the window check when the bundle carries no signing time", () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const bundle = makeBundle(digestHex, { notBefore: new Date("2026-01-01T00:00:00Z"), notAfter: new Date("2026-01-01T00:10:00Z") });
  delete bundle.verificationMaterial.tlogEntries;
  const result = verifyAttestationBundle(bundle, { repo, digestHex });
  assert.equal(result.workflow, workflowUri);
});

test("fetchAttestationBundles treats a 404 as no published record, not an error", async () => {
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const result = await fetchAttestationBundles({
      fetch: (url, init) => fetch(url.replace("https://api.github.com", origin), init),
      repo, digestHex: "a".repeat(64), userAgent: "test",
    });
    assert.equal(result, null);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("fetchAttestationBundles reads a real GitHub-shaped response", async () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const bundle = makeBundle(digestHex);
  const server = createServer((req, res) => {
    assert.equal(req.url, `/repos/${repo}/attestations/sha256:${digestHex}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ attestations: [{ bundle }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const [read] = await fetchAttestationBundles({
      fetch: (url, init) => fetch(url.replace("https://api.github.com", origin), init),
      repo, digestHex, userAgent: "test",
    });
    const result = verifyAttestationBundle(read, { repo, digestHex });
    assert.equal(result.workflow, workflowUri);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("fetchAttestationBundles follows bundle_url when GitHub externalises the bundle", async () => {
  // GitHub's own API answers some attestations this way (`bundle: null`, `bundle_url` set) rather
  // than inline — confirmed against `GET /repos/cli/cli/attestations/<digest>` on a real release.
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const bundle = makeBundle(digestHex);
  const server = createServer((req, res) => {
    if (req.url === `/repos/${repo}/attestations/sha256:${digestHex}`) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ attestations: [{ bundle: null, bundle_url: `${origin()}/blob/one` }] }));
    }
    if (req.url === "/blob/one") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(bundle)); }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = () => `http://127.0.0.1:${server.address().port}`;
  try {
    const [read] = await fetchAttestationBundles({
      fetch: (url, init) => fetch(url.replace("https://api.github.com", origin()), init),
      repo, digestHex, userAgent: "test",
    });
    const result = verifyAttestationBundle(read, { repo, digestHex });
    assert.equal(result.workflow, workflowUri);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

/**
 * A from-scratch, general-purpose raw-Snappy-block encoder, test-only, with no dependency: the
 * inverse of `decodeSnappy` in `src/desktop/provenance.ts`. It greedily backreferences any repeat of
 * 4+ bytes anywhere earlier in the buffer (a real LZ77 match, not a stub), so encoding real bundle
 * JSON — which repeats punctuation, field names and base64 runs throughout — exercises the copy-op
 * path the decoder must handle, the same shape GitHub's blob storage actually serves
 * (`Content-Type: application/x-snappy`, confirmed live against `repos/cli/cli/attestations/...`).
 * Prefers the 1-byte-offset copy form (type 1) whenever the match is in range for it — the form
 * GitHub's real stream actually uses (confirmed: byte offset 0x48 of a live cli/cli bundle is tag
 * `0x09`, a type-1 copy) — and falls back to the 2-byte-offset form (type 2) only when the offset is
 * too far for type 1. Returns `{ encoded, usedCopyType1, usedCopyType2 }` so a test can assert it
 * exercised both copy forms `decodeSnappy` supports, not just literals.
 */
function snappyEncodeForTest(buf) {
  const chunks = [];
  let n = buf.length;
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; chunks.push(Buffer.from([b])); } while (n);
  let usedCopyType1 = false, usedCopyType2 = false;
  let i = 0;
  while (i < buf.length) {
    let bestLen = 0, bestOff = 0;
    const maxOffset = Math.min(i, 65535);
    for (let off = 4; off <= maxOffset; off++) {
      let l = 0;
      const cap = Math.min(64, buf.length - i);
      while (l < cap && buf[i - off + l] === buf[i + l]) l++;
      if (l > bestLen) { bestLen = l; bestOff = off; }
    }
    if (bestLen >= 4) {
      if (bestLen <= 11 && bestOff <= 2047) {
        usedCopyType1 = true;
        const tag = (((bestOff >> 8) & 0x7) << 5) | ((bestLen - 4) << 2) | 0x01;
        chunks.push(Buffer.from([tag, bestOff & 0xff]));
      } else {
        usedCopyType2 = true;
        chunks.push(Buffer.from([((bestLen - 1) << 2) | 0x02, bestOff & 0xff, (bestOff >> 8) & 0xff]));
      }
      i += bestLen;
    } else {
      chunks.push(Buffer.from([0x00]), buf.subarray(i, i + 1)); // literal, length 1
      i += 1;
    }
  }
  return { encoded: Buffer.concat(chunks), usedCopyType1, usedCopyType2 };
}

test("fetchAttestationBundles reads a bundle_url served as raw Snappy (as GitHub's blob storage does)", async () => {
  // Confirmed live: `gh api repos/cli/cli/attestations/sha256:<digest>` answers `bundle_url` pointing
  // at an Azure blob whose response has `Content-Type: application/x-snappy` and whose bytes are the
  // raw Snappy block format (varint length, then literal/copy elements) — not gzip, not framed.
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const bundle = makeBundle(digestHex);
  const bundleJson = Buffer.from(JSON.stringify(bundle), "utf8");
  const { encoded, usedCopyType1, usedCopyType2 } = snappyEncodeForTest(bundleJson);
  assert.ok(usedCopyType1, "the fixture should exercise the 1-byte-offset copy form, the one GitHub's real stream uses");
  assert.ok(usedCopyType2, "the fixture should also exercise the 2-byte-offset copy form");
  const server = createServer((req, res) => {
    if (req.url === `/repos/${repo}/attestations/sha256:${digestHex}`) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ attestations: [{ bundle: null, bundle_url: `${origin()}/blob/one.json.sn` }] }));
    }
    if (req.url === "/blob/one.json.sn") { res.writeHead(200, { "content-type": "application/x-snappy" }); return res.end(encoded); }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = () => `http://127.0.0.1:${server.address().port}`;
  try {
    const [read] = await fetchAttestationBundles({
      fetch: (url, init) => fetch(url.replace("https://api.github.com", origin()), init),
      repo, digestHex, userAgent: "test",
    });
    const result = verifyAttestationBundle(read, { repo, digestHex });
    assert.equal(result.workflow, workflowUri);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("fetchAttestationBundles skips a bundle_url it cannot read as JSON or Snappy, rather than failing the update", async () => {
  // These 6 bytes are a truncated raw-Snappy stream (a valid varint length and literal tag, but the
  // literal itself cut short) — not plain JSON, and not a Snappy body `decodeSnappy` can finish
  // reading either. That combination is treated the same as no bundle at all — quietly skipped,
  // never thrown — never something that could block an update.
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const server = createServer((req, res) => {
    if (req.url === `/repos/${repo}/attestations/sha256:${digestHex}`) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ attestations: [{ bundle: null, bundle_url: `${origin()}/blob/one` }] }));
    }
    if (req.url === "/blob/one") { res.writeHead(200); return res.end(Buffer.from([0x84, 0x32, 0xf0, 0x43, 0x7b, 0x22])); }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = () => `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await fetchAttestationBundles({
      fetch: (url, init) => fetch(url.replace("https://api.github.com", origin()), init),
      repo, digestHex, userAgent: "test",
    });
    assert.deepEqual(result, []);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

/**
 * A full download-through-install fixture, the same shape `tests/updater.test.mjs` uses, with one
 * more route: the build provenance record GitHub would serve at install time. `attestationFor`
 * receives the archive's own digest (only known once it is built) and returns null (no record
 * published, today's reality for every release), a real bundle for that digest, or a bundle for
 * some other file, standing in for one that does not check out.
 */
async function installFixture(t, { attestationFor = () => null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-provenance-"));
  t.after(() => discardTemp(root));
  const source = join(root, "Branch Agent-win32-x64");
  await mkdir(join(source, "resources", "app"), { recursive: true });
  await writeFile(join(source, "Branch Agent Test.exe"), "new executable");
  await writeFile(join(source, "resources", "app", "package.json"), JSON.stringify({ name: "branch-agent", version: "0.3.0" }));
  const archive = join(root, "Branch-Agent-windows-x64.zip");
  if (windows)
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Compress-Archive -LiteralPath '${source}' -DestinationPath '${archive}' -Force`]);
  else await writeFile(archive, "not a real archive");
  const bytes = await readFile(archive);
  const digestHex = createHash("sha256").update(bytes).digest("hex");
  const attestation = attestationFor(digestHex);
  let attestationHits = 0;
  const server = createServer((req, res) => {
    if (req.url === "/repos/stabrea/Branch-Agent/releases/latest") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        tag_name: "v0.3.0", name: "Branch Agent v0.3.0", body: "Notes", published_at: "2026-09-15T00:00:00Z",
        html_url: "https://github.com/stabrea/Branch-Agent/releases/tag/v0.3.0",
        assets: [
          { name: "Branch-Agent-windows-x64.zip", browser_download_url: `${origin()}/download/app.zip`, size: bytes.length },
          { name: "Branch-Agent-windows-x64.zip.sha256", browser_download_url: `${origin()}/download/app.sha256`, size: 96 },
        ],
      }));
    }
    if (req.url === "/download/app.zip") { res.writeHead(200, { "content-length": bytes.length }); return res.end(bytes); }
    if (req.url === "/download/app.sha256") { res.writeHead(200); return res.end(`${digestHex}  Branch-Agent-windows-x64.zip\n`); }
    if (req.url === `/repos/stabrea/Branch-Agent/attestations/sha256:${digestHex}`) {
      attestationHits += 1;
      if (!attestation) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ attestations: [{ bundle: attestation }] }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = () => `http://127.0.0.1:${server.address().port}`;
  const fetchViaFixture = (url, init) => fetch(url.replace("https://api.github.com", origin()), init);
  const installDir = join(root, "installed");
  await mkdir(installDir, { recursive: true });
  await writeFile(join(installDir, "Branch Agent Test.exe"), "old executable");
  return { root, installDir, fetchViaFixture, digestHex, attestationHits: () => attestationHits };
}

test("install proceeds on the checksum alone when no provenance record is published", { skip: !windows && "Windows archive tooling" }, async (t) => {
  const fixture = await installFixture(t);
  const updater = new Updater({
    repo: "stabrea/Branch-Agent", currentVersion: "0.2.0", installDir: fixture.installDir,
    executableName: "Branch Agent Test.exe", assetName: "Branch-Agent-windows-x64.zip",
    scratchDir: join(fixture.root, "scratch"), fetch: fixture.fetchViaFixture,
  });
  const { script } = await updater.install();
  assert.ok(script);
  assert.equal(fixture.attestationHits(), 1, "the updater asked GitHub for a provenance record");
});

test("install checks out a real provenance record and shows it", { skip: !windows && "Windows archive tooling" }, async (t) => {
  const fixture = await installFixture(t, { attestationFor: (digestHex) => makeBundle(digestHex) });
  const updater = new Updater({
    repo: "stabrea/Branch-Agent", currentVersion: "0.2.0", installDir: fixture.installDir,
    executableName: "Branch Agent Test.exe", assetName: "Branch-Agent-windows-x64.zip",
    scratchDir: join(fixture.root, "scratch"), fetch: fixture.fetchViaFixture,
  });
  const { script } = await updater.install();
  assert.ok(script);
  assert.equal(fixture.attestationHits(), 1);
});

test("install refuses a provenance record for a different file, and removes what was downloaded", { skip: !windows && "Windows archive tooling" }, async (t) => {
  const fixture = await installFixture(t, {
    attestationFor: () => makeBundle(createHash("sha256").update("some other file entirely").digest("hex")),
  });
  const updater = new Updater({
    repo: "stabrea/Branch-Agent", currentVersion: "0.2.0", installDir: fixture.installDir,
    executableName: "Branch Agent Test.exe", assetName: "Branch-Agent-windows-x64.zip",
    scratchDir: join(fixture.root, "scratch"), fetch: fixture.fetchViaFixture,
  });
  await assert.rejects(updater.install(), /provenance record did not check out/);
  await assert.rejects(readFile(join(fixture.root, "scratch", "Branch-Agent-windows-x64.zip")), /ENOENT/);
});
