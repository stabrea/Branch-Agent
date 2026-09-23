import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { SerialChannel, serialService, devicePath, openSerialPort } from "../dist/channels/serial.js";
import { parityServices } from "../dist/channels/connectors.js";

/**
 * FQ-execution.hardware: the serial adapter, exercised against a device fixture (a PassThrough pair
 * standing in for a real port) rather than a real microcontroller. Covers the acceptance text: a
 * line to and from a device, an unsupported protocol (GPIO, I2C, SPI) reported by name, and a
 * disconnect reported explicitly rather than silently.
 */

async function until(check, label, tries = 200) {
  for (let i = 0; i < tries; i++) { const value = await check(); if (value) return value; await delay(10); }
  assert.fail(`Timed out: ${label}`);
}

/**
 * A device fixture standing in for a real serial port. A `PassThrough` is already a duplex byte
 * stream, so what the test writes to it is what the channel reads (as if a device had sent it), and
 * what the channel writes to it is what the test can read back (as if a device were listening).
 */
function deviceFixture() {
  return new PassThrough();
}

test("serial: a line from the device fixture reaches onMessage", async () => {
  const port = deviceFixture();
  const opened = [];
  const channel = new SerialChannel({
    id: "serial", path: "/dev/ttyUSB0", baudRate: 9600, deviceName: "arduino", lineEnding: "\n",
    open: async (target) => { opened.push(target); return port; }, retryBaseMs: 10,
  });
  const seen = [];
  await channel.start(async (message) => { seen.push(message); });
  await until(() => channel.health().state === "connected", "channel connects");
  port.write("hello from the board\n");
  const message = await until(() => seen[0], "a message arrives");
  assert.equal(message.text, "hello from the board");
  assert.equal(message.senderName, "arduino");
  assert.equal(message.chatId, "arduino");
  assert.equal(message.chatKind, "direct");
  assert.equal(opened[0].path, "/dev/ttyUSB0");
  assert.equal(opened[0].baudRate, 9600);
  await channel.stop();
});

test("serial: send() writes a line to the device fixture", async () => {
  const port = deviceFixture();
  const channel = new SerialChannel({
    id: "serial", path: "/dev/ttyUSB0", baudRate: 9600, deviceName: "arduino", lineEnding: "\n",
    open: async () => port, retryBaseMs: 10,
  });
  await channel.start(async () => undefined);
  await until(() => channel.health().state === "connected", "channel connects");
  const written = new Promise((resolve) => port.once("data", (chunk) => resolve(chunk.toString())));
  await channel.send("arduino", "on\r\nnow");
  assert.equal(await written, "on  now\n"); // a carriage return or newline in the text cannot open a second line
  await channel.stop();
});

test("serial: a disconnect is reported explicitly and send() then refuses", async () => {
  const port = deviceFixture();
  const channel = new SerialChannel({
    id: "serial", path: "/dev/ttyUSB0", baudRate: 9600, deviceName: "arduino", lineEnding: "\n",
    open: async () => port, retryBaseMs: 10,
  });
  await channel.start(async () => undefined);
  await until(() => channel.health().state === "connected", "channel connects");
  port.end(); // the device fixture hangs up
  await until(() => channel.health().state === "reconnecting", "the drop is noticed");
  assert.equal(channel.health().reason, "The serial device disconnected");
  await assert.rejects(() => channel.send("arduino", "hi"), /not open/);
  await channel.stop();
});

test("serial: send() before the port opens refuses instead of throwing an unrelated error", async () => {
  // `open` never settles, standing in for a port that is still being opened; `stop()` cannot
  // interrupt that wait (the real opener has no cancellation either), so this test never calls it.
  const channel = new SerialChannel({
    id: "serial", path: "/dev/ttyUSB0", baudRate: 9600, deviceName: "arduino", lineEnding: "\n",
    open: () => new Promise(() => {}),
    retryBaseMs: 10,
  });
  await channel.start(async () => undefined);
  assert.equal(channel.health().state, "reconnecting");
  await assert.rejects(() => channel.send("arduino", "hi"), /not open/);
});

test("serial: GPIO, I2C and SPI are declared but refused by name, not silently ignored", async () => {
  const deps = { id: "serial", platform: "linux" };
  for (const [protocol, label] of [["gpio", "GPIO"], ["i2c", "I2C"], ["spi", "SPI"]]) {
    const settings = serialService.settings.parse({ path: "/dev/ttyUSB0", baudRate: 9600, protocol });
    await assert.rejects(() => serialService.build(settings, deps), new RegExp(`${label} is not supported`));
  }
});

test("serial: build() opens the declared serial protocol with a valid path", async () => {
  const deps = { id: "serial", platform: "linux" };
  const settings = serialService.settings.parse({ path: "/dev/ttyUSB0", baudRate: 9600 });
  const built = await serialService.build(settings, deps);
  assert.equal(built.kind, "serial");
  await built.stop();
});

test("serial: an unrecognized port name is refused before it reaches the filesystem", () => {
  assert.throws(() => devicePath("../../etc/passwd", "linux"), /not a serial device/);
  assert.throws(() => devicePath("COM0", "win32"), /not a serial port name/);
  assert.equal(devicePath("COM12", "win32"), "\\\\.\\COM12");
  assert.equal(devicePath("/dev/ttyUSB0", "linux"), "/dev/ttyUSB0");
});

test("serial: a non-standard baud rate is refused", () => {
  assert.throws(() => serialService.settings.parse({ path: "/dev/ttyUSB0", baudRate: 9601 }));
});

test("serial: openSerialPort is exported for the real device path (not exercised against real hardware here)", () => {
  assert.equal(typeof openSerialPort, "function");
});

test("serial: the service is registered where the owner turns it on", () => {
  const kinds = parityServices.map((service) => service.kind);
  assert.ok(kinds.includes("serial"), "serial is a listed chat/device service");
  assert.equal(new Set(kinds).size, kinds.length, "no service is listed twice");
});
