// The phone app's rules (apps/mobile/web): which addresses it talks to, how an invitation is read,
// what "Send to Branch" sends, the secure-storage wrapper, the native palette and the QR reader.
// Pure logic only: no phone, no camera, no network.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import * as catalogue from "../public/theme-catalogue.js";
import { encodeQr } from "../dist/remote/qr.js";
import {
  DEFAULT_SWITCHES, checkAddress, isPrivateHost, newAttention, pairingBody, planShare, pollPlan, readInvitation, readSwitches,
} from "../apps/mobile/web/rules.js";
import { nativePalette, nativePalettes, opaque, androidColour } from "../apps/mobile/web/palette.js";
import { createVault } from "../apps/mobile/web/vault.js";
import { readFrame } from "../apps/mobile/web/scan.js";

const offer = "0f8b2c1e-7d3a-4b5c-9e6f-a1b2c3d4e5f6";

test("plain http is only for the owner's own network and tailnet", () => {
  for (const host of ["100.64.0.1", "100.127.255.254", "10.0.0.2", "172.16.4.4", "172.31.0.1", "192.168.1.20",
    "127.0.0.1", "localhost", "desk-pc.tail1234.ts.net", "desk.local", "nas.home.arpa", "[fd7a:115c:a1e0::1]", "[::1]"])
    assert.equal(isPrivateHost(host), true, host);
  for (const host of ["8.8.8.8", "100.63.255.255", "100.128.0.1", "172.32.0.1", "192.169.0.1", "example.com",
    "ts.net", "evil-ts.net", "desk-pc", "local", "[2001:db8::1]", "", "999.1.1.1"])
    assert.equal(isPrivateHost(host), false, host);
});

test("an address is checked before anything is sent to it", () => {
  assert.equal(checkAddress("http://100.101.102.103:3210/pair?id=x"), "http://100.101.102.103:3210");
  assert.equal(checkAddress("https://branch.example.com"), "https://branch.example.com");
  assert.throws(() => checkAddress("http://branch.example.com"), /Plain http is only allowed/);
  assert.throws(() => checkAddress("ftp://100.64.0.1"), /Only http/);
  assert.throws(() => checkAddress("javascript:alert(1)"), /Only http/);
  assert.throws(() => checkAddress("http://me:secret@100.64.0.1"), /name and password/);
  assert.throws(() => checkAddress("not an address"), /not an address/);
});

test("an invitation link gives the address and the offer; a bare address gives only the address", () => {
  assert.deepEqual(readInvitation(`http://desk.tail1.ts.net:4567/pair?id=${offer}`), { origin: "http://desk.tail1.ts.net:4567", offerId: offer });
  assert.deepEqual(readInvitation(" 100.64.1.2:3210 "), { origin: "http://100.64.1.2:3210", offerId: null });
  assert.throws(() => readInvitation("http://100.64.1.2:3210/pair?id=../../x"), /damaged/);
  assert.throws(() => readInvitation("203.0.113.9:3210"), /Plain http/);
  assert.throws(() => readInvitation(""), /Scan the square code/);
});

test("the six numbers are checked the way the computer checks them", () => {
  assert.deepEqual(pairingBody(offer, " 123 456 ", "Pixel"), { id: offer, code: "123456", name: "Pixel" });
  assert.equal(pairingBody(offer, "000001", "   ").name, "A phone");
  assert.equal(pairingBody(offer, "000001", "x".repeat(200)).name.length, 80);
  assert.throws(() => pairingBody(offer, "12345", "x"), /six numbers/);
  assert.throws(() => pairingBody(null, "123456", "x"), /Scan the square code first/);
});

test("every switch starts off, and an unknown position reads as off", () => {
  assert.deepEqual(readSwitches(undefined), DEFAULT_SWITCHES);
  assert.deepEqual(Object.values(DEFAULT_SWITCHES), ["off", "off", "off", "off", "off"]);
  assert.equal(readSwitches({ lock: "on", share: "always", voice: "when-needed" }).share, "off");
  assert.equal(readSwitches({ lock: "on" }).lock, "on");
  assert.deepEqual(pollPlan("off"), { foreground: false, background: false, everySeconds: 0 });
  assert.deepEqual(pollPlan("when-needed"), { foreground: true, background: false, everySeconds: 60 });
  assert.equal(pollPlan("on").background, true);
});

test("Send to Branch: words start a conversation, pictures ride along, other files go to Documents", () => {
  const png = Buffer.alloc(900).toString("base64");
  const pdf = Buffer.alloc(1200).toString("base64");
  const { requests, refused } = planShare([
    { kind: "url", text: "https://example.com/a" },
    { kind: "file", name: "p.png", type: "image/png", data: png },
    { kind: "file", name: "r.pdf", type: "application/pdf", data: pdf },
    { kind: "file", name: "huge.bin", type: "application/octet-stream", data: "A".repeat(28 * 1024 * 1024) },
    { kind: "nonsense" },
  ], "Look at this");
  assert.deepEqual(requests[0], { method: "POST", path: "/api/run", body: {
    prompt: "Look at this\n\nhttps://example.com/a", images: [{ mediaType: "image/png", data: png, name: "p.png" }] } });
  assert.deepEqual(requests[1], { method: "POST", path: "/api/documents", body: { name: "r.pdf", content: pdf } });
  assert.equal(requests.length, 2);
  assert.deepEqual(refused.map((each) => each.reason), ["too-big", "unreadable"]);
  const onlyPicture = planShare([{ kind: "file", name: "x.jpg", type: "image/jpeg", data: png }]);
  assert.equal(onlyPicture.requests[0].body.prompt, "Here is a picture from my phone.");
  const five = planShare(Array.from({ length: 5 }, (_, i) => ({ kind: "file", name: `${i}.png`, type: "image/png", data: png })));
  assert.equal(five.requests[0].body.images.length, 4);
  assert.equal(five.requests[1].path, "/api/documents");
  assert.deepEqual(planShare([]).requests, []);
});

test("a notification is only for something new that is waiting for the owner", () => {
  const state = { attention: [{ runId: "a", question: "Which folder?" }, { runId: "b", question: "x".repeat(400) }, { question: "no id" }] };
  assert.deepEqual(newAttention(state, ["a"]).map((each) => each.id), ["b"]);
  assert.equal(newAttention(state, []).at(1).question.length, 180);
  assert.deepEqual(newAttention({}, []), []);
});

test("the secure-storage wrapper never hands the page the key", async () => {
  const calls = [];
  const kept = {};
  const plugin = {
    async pair(input) { calls.push(["pair", input]); Object.assign(kept, { origin: input.origin, token: "SECRET", deviceKey: "K" }); return { paired: true }; },
    async session() { return { paired: Boolean(kept.origin), origin: kept.origin, token: kept.token, deviceKey: kept.deviceKey, pairedAt: "2026-09-17" }; },
    async forget() { for (const key of Object.keys(kept)) delete kept[key]; },
    async request(input) { calls.push(["request", input]); return { status: input.path === "/api/bad" ? 401 : 200, data: input.path === "/api/bad" ? { error: "Nope" } : { ok: 1 } }; },
    switches: {},
    async getSwitches() { return { switches: this.switches }; },
    async setSwitches({ switches }) { this.switches = switches; },
  };
  const vault = createVault(plugin);
  assert.equal(await vault.current(), null);
  await assert.rejects(vault.pair({ origin: "http://8.8.8.8:1", offerId: offer }, "123456", "p"), /Plain http/);
  assert.equal(calls.length, 0, "a refused address is never handed to the native side");
  assert.equal(await vault.pair({ origin: "http://100.64.0.9:3210", offerId: offer }, "123456", "Pixel"), "http://100.64.0.9:3210");
  assert.deepEqual(calls[0], ["pair", { origin: "http://100.64.0.9:3210", id: offer, code: "123456", name: "Pixel" }]);
  const seen = await vault.current();
  assert.deepEqual(seen, { origin: "http://100.64.0.9:3210", pairedAt: "2026-09-17" });
  assert.equal(JSON.stringify(seen).includes("SECRET"), false);
  assert.deepEqual(await vault.request("GET", "/api/state"), { ok: 1 });
  await assert.rejects(vault.request("GET", "https://elsewhere.example/api/state"), /Only Branch's own/);
  await assert.rejects(vault.request("GET", "/api/bad"), /Nope/);
  assert.equal((await vault.setSwitch("lock", "on")).lock, "on");
  assert.equal((await vault.setSwitch("lock", "sometimes")).lock, "off");
  await vault.forget();
  assert.equal(await vault.current(), null);
  assert.throws(() => createVault(undefined), /not running inside the phone app/);
});

test("native colours come from the theme table, laid over the ground when see-through", () => {
  const forest = nativePalette(catalogue, "forest", "dark");
  const values = catalogue.THEMES[0][3].dark;
  assert.equal(forest.ground, opaque(values[catalogue.TOKEN_NAMES.indexOf("--ground")]));
  assert.equal(forest.accent, opaque(values[catalogue.TOKEN_NAMES.indexOf("--copper")]));
  assert.equal(forest.statusBar, "light");
  for (const [role, value] of Object.entries(forest))
    if (!["theme", "mode", "statusBar"].includes(role)) assert.match(value, /^#[0-9A-F]{6}$/, role);
  const both = nativePalettes(catalogue, "no-such-theme");
  assert.equal(both.light.theme, catalogue.THEMES[0][0]);
  assert.equal(both.light.statusBar, "dark");
  assert.equal(opaque("rgba(255,255,255,.5)", "#000000"), "#808080");
  assert.equal(androidColour("#03140b"), "#FF03140B");
  assert.throws(() => opaque("red"), /Not a colour/);
});

const decoderPath = new URL("../apps/mobile/node_modules/jsqr/dist/jsQR.js", import.meta.url);
test("the square code the computer draws is read back by the phone's decoder", {
  skip: existsSync(decoderPath) ? false : "apps/mobile has not been installed (npm ci in apps/mobile)",
}, () => {
  const jsQR = createRequire(import.meta.url)(decoderPath.pathname);
  const text = `http://desk-pc.tail1234.ts.net:40123/pair?id=${offer}`;
  const matrix = encodeQr(text);
  const scale = 6, quiet = 4, size = (matrix.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let row = 0; row < matrix.size; row++)
    for (let column = 0; column < matrix.size; column++) {
      if (!matrix.modules[row][column]) continue;
      for (let y = 0; y < scale; y++)
        for (let x = 0; x < scale; x++) {
          const at = (((row + quiet) * scale + y) * size + (column + quiet) * scale + x) * 4;
          data[at] = data[at + 1] = data[at + 2] = 0;
        }
    }
  const decode = jsQR.default ?? jsQR;
  assert.equal(readFrame(decode, { data, width: size, height: size }), text);
  assert.deepEqual(readInvitation(readFrame(decode, { data, width: size, height: size })).offerId, offer);
  assert.equal(readFrame(decode, { data: new Uint8ClampedArray(64 * 64 * 4), width: 64, height: 64 }), null);
  assert.equal(readFrame(decode, null), null);
});
