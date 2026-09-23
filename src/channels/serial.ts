import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { Duplex, type Readable, type Writable } from "node:stream";
import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";
import { reconnectDelay } from "./ws-client.js";
import { defineService, readLines } from "./parity-common.js";

/**
 * A serial line to a device wired straight to this computer — a microcontroller, sensor board or
 * actuator, not something on the network, so MQTT cannot reach it. Of the four buses an owner may
 * ask for here (serial, GPIO, I2C, SPI), serial is the one that actually crosses a cable a desktop
 * or laptop has: GPIO, I2C and SPI address pins on a header this kind of computer does not carry.
 * Asking for one of those three is refused by name in `build`, rather than quietly becoming a
 * serial line the owner did not ask for.
 *
 * There is no framing to agree beyond lines: a device prints one line of text and the assistant
 * answers with one, the way a microcontroller sketch (`Serial.println`) or a serial monitor already
 * works. That is simpler than MQTT's JSON shape because there is exactly one device on the wire, so
 * nothing needs a `from` or a `chat` to tell two of them apart.
 */

/** The three buses this adapter declares but cannot reach from an ordinary computer, by name. */
const unsupportedProtocol: Record<string, string> = { gpio: "GPIO", i2c: "I2C", spi: "SPI" };

/** Baud rates a real UART actually offers; anything else is almost always a typo. */
const standardBaudRates = new Set([
  110, 300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 28800, 38400, 56000, 57600, 76800,
  115200, 128000, 153600, 230400, 250000, 256000, 460800, 500000, 921600, 1000000, 2000000,
]);

const winPort = /^COM([1-9][0-9]{0,2})$/i;
const posixPort = /^\/dev\/(tty|cu)[A-Za-z0-9._-]+$/;

/**
 * The path Node actually opens for the port the owner named. A bad name is refused here rather than
 * handed to the filesystem, since a loosely checked "path" setting would otherwise be a way to open
 * any file on the computer.
 */
export function devicePath(raw: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    if (!winPort.test(raw)) throw new Error(`"${raw}" is not a serial port name (COM1, COM2, …)`);
    // Ports above COM9 only open through the \\.\ prefix; it is never wrong to add it.
    return `\\\\.\\${raw.toUpperCase()}`;
  }
  if (!posixPort.test(raw)) throw new Error(`"${raw}" is not a serial device (/dev/ttyUSB0, /dev/cu.usbserial-…)`);
  return raw;
}

export interface SerialTarget { path: string; baudRate: number; platform: NodeJS.Platform }
export type SerialPortOpener = (target: SerialTarget) => Promise<Duplex>;

/** Joins a readable and a writable Node stream into the one Duplex the channel reads and writes. */
class JoinedPort extends Duplex {
  constructor(private readonly source: Readable, private readonly sink: Writable) {
    super();
    source.on("data", (chunk: Buffer) => { if (!this.push(chunk)) source.pause(); });
    source.once("end", () => this.push(null));
    source.once("error", (error) => this.destroy(error));
    sink.once("error", (error) => this.destroy(error));
  }
  override _read(): void { this.source.resume(); }
  override _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    this.sink.write(chunk, (error) => callback(error ?? null));
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.source.destroy();
    this.sink.destroy();
    callback(error);
  }
}

/**
 * Opens the device file and asks the operating system for the line's baud rate. Setting the rate
 * runs an external program (`stty` or `mode`) this cannot exercise against a real port in a test, so
 * a failure there is swallowed and only the byte stream itself is what the channel relies on — the
 * actual hardware handshake is the part this closes with a local adapter and a test double rather
 * than with a real device, as the remaining acceptance text allows.
 */
export const openSerialPort: SerialPortOpener = ({ path, baudRate, platform }) => new Promise((resolve, reject) => {
  const finish = () => {
    const source = createReadStream(path);
    const sink = createWriteStream(path);
    const port = new JoinedPort(source, sink);
    source.once("open", () => resolve(port));
    source.once("error", (error) => reject(error));
  };
  if (platform === "win32") {
    const name = path.replace(/^\\\\\.\\/, "");
    execFile("mode.com", [`${name}:`, `baud=${baudRate}`, "parity=n", "data=8", "stop=1"], () => finish());
  } else {
    execFile("stty", ["-F", path, String(baudRate), "raw", "-echo"], () => finish());
  }
});

export interface SerialOptions {
  id: string;
  path: string;
  baudRate: number;
  deviceName: string;
  open: SerialPortOpener;
  lineEnding: string;
  retryBaseMs?: number;
}

export class SerialChannel implements ChannelAdapter {
  readonly id: string;
  readonly kind = "serial";
  readonly maxTextLength = 4000;
  private state: ChannelHealth = { state: "reconnecting", reason: "Opening the serial port" };
  private link: Duplex | null = null;
  private stopping = false;
  private loop: Promise<void> | null = null;
  private counter = 0;
  private onMessage: (message: InboundMessage) => Promise<void> = async () => undefined;
  constructor(private readonly options: SerialOptions) { this.id = options.id; }
  botName(): string | null { return this.options.deviceName; }
  health(): ChannelHealth { return this.state; }

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.stopping = false;
    this.onMessage = onMessage;
    this.loop = this.run();
    await Promise.race([this.loop, new Promise((resolve) => setTimeout(resolve, 50))]);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.link?.destroy();
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }

  private async run(): Promise<void> {
    for (let attempt = 0; !this.stopping; attempt++) {
      try {
        const link = await this.options.open({ path: this.options.path, baudRate: this.options.baudRate, platform: process.platform });
        this.link = link;
        this.state = { state: "connected" };
        await this.session(link);
        attempt = 0; // a session that ran at all was connected; the next failure starts the backoff over
        if (!this.stopping) this.state = { state: "reconnecting", reason: "The serial device disconnected" };
      } catch (error) {
        if (this.stopping) return;
        this.state = { state: "reconnecting", reason: `Could not open the serial port: ${error instanceof Error ? error.message : String(error)}` };
      }
      this.link = null;
      if (this.stopping) return;
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay(attempt + 1, this.options.retryBaseMs ?? 1000)));
    }
  }
  /** One open port, from the moment it opens until it closes or errors. */
  private session(link: Duplex): Promise<void> {
    return new Promise((resolve) => {
      link.once("close", resolve);
      link.on("error", () => { link.destroy(); resolve(); });
      readLines(link, (line) => {
        const inbound = this.inbound(line);
        if (inbound) void this.onMessage(inbound).catch(() => undefined);
      });
    });
  }
  private inbound(line: string): InboundMessage | null {
    const text = line.trim();
    if (!text) return null;
    return {
      channel: this.id, chatId: this.options.deviceName, chatKind: "direct",
      senderId: this.options.deviceName, senderName: this.options.deviceName,
      text, addressed: true, messageId: `${Date.now()}-${++this.counter}`,
    };
  }

  async send(_chatId: string, text: string): Promise<string | undefined> {
    if (!this.link || this.state.state !== "connected" || !this.link.writable)
      throw new Error("The serial port is not open, so the message could not be sent");
    const line = text.replace(/[\r\n]/g, " ").slice(0, this.maxTextLength) + this.options.lineEnding;
    this.link.write(line);
    return undefined;
  }
}

const portPath = z.string().min(1).max(64);
export const serialService = defineService({
  kind: "serial", name: "Serial device", docs: "https://en.wikipedia.org/wiki/Serial_port",
  needs: ["The device's serial port name (COM3 on Windows, /dev/ttyUSB0 or /dev/cu.usbserial-… elsewhere)",
    "Its baud rate", "A name for the device"],
  receives: "socket",
  settings: z.object({
    path: portPath,
    baudRate: z.number().int().refine((value) => standardBaudRates.has(value), "Not a standard baud rate"),
    deviceName: z.string().min(1).max(60).default("device"),
    protocol: z.enum(["serial", "gpio", "i2c", "spi"]).default("serial"),
    lineEnding: z.enum(["\n", "\r\n"]).default("\n"),
  }).strict(),
  async build(settings, deps) {
    if (settings.protocol !== "serial") {
      const label = unsupportedProtocol[settings.protocol] ?? settings.protocol;
      throw new Error(`${label} is not supported here; only a serial line is. Wire the device through a serial adapter instead.`);
    }
    const path = devicePath(settings.path, deps.platform);
    return new SerialChannel({
      id: deps.id, path, baudRate: settings.baudRate, deviceName: settings.deviceName,
      lineEnding: settings.lineEnding, open: openSerialPort,
    });
  },
});
