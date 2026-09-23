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

/** A real, signed Sigstore-shaped bundle for `digestHex`, issued by a freshly made test certificate. */
function makeBundle(digestHex, { uri = workflowUri, notBefore, notAfter } = {}) {
  const { certificateDer, privateKey } = makeWorkflowCertificate({ workflowUri: uri, notBefore, notAfter });
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
    verificationMaterial: { certificate: { rawBytes: certificateDer.toString("base64") } },
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

test("verifyAttestationBundle refuses a bundle whose certificate has expired", () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const bundle = makeBundle(digestHex, { notBefore: new Date(Date.now() - 86_400_000), notAfter: new Date(Date.now() - 3_600_000) });
  assert.throws(() => verifyAttestationBundle(bundle, { repo, digestHex }), /not currently valid/);
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
