import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey, createVerify } from "node:crypto";
import { GitHubAppAccess, chooseGitHubTokenSource, signAppJwt } from "../dist/integrations/github-app.js";
import { NetworkPolicy } from "../dist/index.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ format: "pem", type: "pkcs8" });
const publicPem = createPublicKey(privateKey).export({ format: "pem", type: "spki" });
const open = () => new NetworkPolicy({ allowPrivateAddresses: true });
const ids = { appId: "12345", privateKeySecret: "GITHUB_APP_KEY", installationId: "456" };
const vault = (asked = []) => async (name) => { asked.push(name); if (name !== "GITHUB_APP_KEY") throw new Error("no such secret"); return pem; };
const tokenReply = (token, expiresAt) => new Response(JSON.stringify({ token, expires_at: new Date(expiresAt).toISOString() }), { status: 201 });

test("A2227 the app token is RS256-signed with the app number and a nine-minute life", () => {
  const now = 1_700_000_000_000;
  const jwt = signAppJwt(pem, "12345", now);
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  assert.deepEqual(claims, { iss: "12345", iat: now / 1000 - 60, exp: now / 1000 + 540 });
  const verifier = createVerify("sha256");
  verifier.update(`${header}.${payload}`);
  assert.ok(verifier.verify(publicPem, Buffer.from(signature, "base64url")));
  assert.throws(() => signAppJwt("-----BEGIN PRIVATE KEY-----\nnot-a-key-SECRETBODY\n-----END PRIVATE KEY-----", "1", now), // not-a-real-secret
    (error) => /could not be read/.test(error.message) && !error.message.includes("SECRETBODY"));
});

test("A2227 the key comes from the locker, the exchange goes to the saved address and the token is kept until near expiry", async () => {
  let now = 1_700_000_000_000;
  const calls = [];
  const asked = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, authorization: init.headers.authorization });
    return tokenReply(`ghs_${calls.length}`, now + 3_600_000);
  };
  const app = new GitHubAppAccess(ids, open(), vault(asked), fetchImpl, () => now, "BranchAgent", "https://github.example.test/api/v3");
  assert.equal(await app.getInstallationToken(), "ghs_1");
  assert.equal(calls[0].url, "https://github.example.test/api/v3/app/installations/456/access_tokens");
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.deepEqual(asked, ["GITHUB_APP_KEY"], "only the named secret is read");

  now += 50 * 60_000;
  assert.equal(await app.getInstallationToken(), "ghs_1", "still more than five minutes left: kept");
  now += 6 * 60_000;
  assert.equal(await app.getInstallationToken(), "ghs_2", "less than five minutes left: exchanged again");
  assert.equal(calls.length, 2);
});

test("A2227 the network rules are asked first, and a refusal never quotes the key or the signed token", async () => {
  let fetched = false;
  const blocked = new NetworkPolicy({ allowPrivateAddresses: true, blockedHosts: ["api.github.com"] });
  const app = new GitHubAppAccess(ids, blocked, vault(), async () => { fetched = true; return tokenReply("x", Date.now() + 3_600_000); });
  await assert.rejects(app.getInstallationToken(), /blocked list/);
  assert.equal(fetched, false, "nothing left the computer");

  let sentJwt = "";
  const echo = async (_url, init) => {
    sentJwt = init.headers.authorization.slice(7);
    return new Response(`bad credentials for ${sentJwt} and ${pem}`, { status: 401 });
  };
  const failing = new GitHubAppAccess(ids, open(), vault(), echo);
  await assert.rejects(failing.getInstallationToken(), (error) => {
    assert.match(error.message, /401/);
    assert.equal(error.message.includes(sentJwt), false, "the signed token is scrubbed");
    assert.equal(error.message.includes("PRIVATE KEY"), false, "the key is scrubbed");
    return true;
  });

  const missing = new GitHubAppAccess({ ...ids, privateKeySecret: "NOT_SAVED" }, open(), vault(), echo);
  await assert.rejects(missing.getInstallationToken(), /locker as NOT_SAVED/);
});

test("A2227 off uses the personal token; on uses the app and never falls back quietly", async () => {
  const personal = async () => "ghp_personal";
  const fetchImpl = async () => tokenReply("ghs_app", Date.now() + 3_600_000);

  assert.equal(chooseGitHubTokenSource(undefined, personal, open(), vault(), { fetchImpl }), personal, "nothing saved means off");
  assert.equal(chooseGitHubTokenSource({ mode: "off", ...ids }, personal, open(), vault(), { fetchImpl }), personal);
  assert.equal(chooseGitHubTokenSource({ mode: "when-needed" }, personal, open(), vault(), { fetchImpl }), personal,
    "when needed without the app's details: the personal token");

  const on = chooseGitHubTokenSource({ mode: "on", ...ids }, personal, open(), vault(), { fetchImpl });
  assert.equal(await on(), "ghs_app");

  const incomplete = chooseGitHubTokenSource({ mode: "on", appId: "1" }, personal, open(), vault(), { fetchImpl });
  await assert.rejects(incomplete(), /switched on but/);

  const broken = chooseGitHubTokenSource({ mode: "on", ...ids }, personal, open(), vault(),
    { fetchImpl: async () => new Response("nope", { status: 500 }) });
  await assert.rejects(broken(), /did not hand over/, "a failing app is an error, not the personal token");

  assert.throws(() => chooseGitHubTokenSource({ mode: "on", privateKey: pem }, personal, open(), vault()),
    "the key itself can never be written into the settings");
});
