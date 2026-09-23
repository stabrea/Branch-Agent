// FQ-surfaces.mobile-push: Web Push encryption (RFC 8291) and VAPID signing (RFC 8292), checked
// against RFC 8291 Appendix A's own published test vectors rather than a self-referential round
// trip — see src/web-push-crypto.ts's file comment for why. Pure logic only: no network.
import assert from "node:assert/strict";
import test from "node:test";
import {
  encryptWebPush, fromBase64Url, generateEcKeyPair, signVapidJwt, toBase64Url, verifyVapidJwt,
} from "../dist/web-push-crypto.js";

// RFC 8291 §5 and Appendix A, verbatim.
const vector = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

test("encryptWebPush reproduces RFC 8291 Appendix A's worked example exactly", () => {
  const { body } = encryptWebPush(fromBase64Url(vector.plaintext), {
    p256dh: fromBase64Url(vector.uaPublic),
    auth: fromBase64Url(vector.authSecret),
  }, {
    salt: fromBase64Url(vector.salt),
    sender: { publicKeyRaw: fromBase64Url(vector.asPublic), privateKeyRaw: fromBase64Url(vector.asPrivate) },
  });
  assert.equal(toBase64Url(body), vector.body);
});

test("encryptWebPush refuses a subscription key that is not an uncompressed P-256 point", () => {
  assert.throws(() => encryptWebPush(Buffer.from("hi"), { p256dh: Buffer.alloc(64), auth: Buffer.alloc(16) }));
  assert.throws(() => encryptWebPush(Buffer.from("hi"), { p256dh: fromBase64Url(vector.uaPublic), auth: Buffer.alloc(15) }));
});

test("a fresh encryption of the same plaintext never repeats a salt or a ciphertext", () => {
  const receiver = { p256dh: fromBase64Url(vector.uaPublic), auth: fromBase64Url(vector.authSecret) };
  const first = encryptWebPush(Buffer.from("hello"), receiver);
  const second = encryptWebPush(Buffer.from("hello"), receiver);
  assert.notEqual(toBase64Url(first.body), toBase64Url(second.body));
});

test("signVapidJwt produces a JWT whose ES256 signature verifies against its own public key, aud the endpoint's origin", () => {
  const { publicKeyRaw, privateKeyRaw } = generateEcKeyPair();
  const key = { x: toBase64Url(publicKeyRaw.subarray(1, 33)), y: toBase64Url(publicKeyRaw.subarray(33, 65)), d: toBase64Url(privateKeyRaw) };
  const jwt = signVapidJwt(key, "https://push.example.net", "mailto:push@branch-agent.invalid");
  const [header, claims] = jwt.split(".");
  assert.deepEqual(JSON.parse(fromBase64Url(header).toString("utf8")), { typ: "JWT", alg: "ES256" });
  const parsedClaims = JSON.parse(fromBase64Url(claims).toString("utf8"));
  assert.equal(parsedClaims.aud, "https://push.example.net");
  assert.equal(parsedClaims.sub, "mailto:push@branch-agent.invalid");
  assert.equal(verifyVapidJwt(jwt, key), true);
});

test("signVapidJwt's signature does not verify against a different key", () => {
  const a = generateEcKeyPair(), b = generateEcKeyPair();
  const keyA = { x: toBase64Url(a.publicKeyRaw.subarray(1, 33)), y: toBase64Url(a.publicKeyRaw.subarray(33, 65)), d: toBase64Url(a.privateKeyRaw) };
  const keyB = { x: toBase64Url(b.publicKeyRaw.subarray(1, 33)), y: toBase64Url(b.publicKeyRaw.subarray(33, 65)) };
  const jwt = signVapidJwt(keyA, "https://push.example.net");
  assert.equal(verifyVapidJwt(jwt, keyB), false);
});
