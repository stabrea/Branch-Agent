import { connect, type Client } from "../cli-attach.js";
import { parseSendArgs } from "./platform.js";

/**
 * R17-081: `branch send <chat app> <chat> [words]`. With no words, whatever is piped in is sent,
 * so a script can end with `… | branch send telegram 12345`. It talks to the engine already running
 * on this computer, through the same door and key as the app window, and never starts one of its own.
 * `--json` prints the answer as JSON.
 */
export async function readPiped(stream: NodeJS.ReadStream = process.stdin, limit = 64 * 1024): Promise<string> {
  if (stream.isTTY) return "";
  let text = "";
  for await (const chunk of stream) {
    text += String(chunk);
    if (text.length > limit) return text.slice(0, limit);
  }
  return text;
}

export async function sendCommand(argv: readonly string[], dataDir: string,
  deps: { client?: Client; piped?: () => Promise<string>; print?: (line: string) => void } = {}): Promise<void> {
  const words = argv.filter((a) => a !== "--json");
  const hasWords = words.length > 2;
  const input = parseSendArgs(words, hasWords ? "" : await (deps.piped ?? readPiped)());
  const client = deps.client ?? await connect(dataDir);
  const answer = await client.post<{ channel: string; chat: string; queued: number }>("/api/reach/send", input, 60_000);
  const print = deps.print ?? ((line: string) => console.log(line));
  print(argv.includes("--json") ? JSON.stringify(answer) : `Sent to ${answer.chat} on ${answer.channel}${answer.queued ? ` (${answer.queued} part(s) waiting to go)` : ""}.`);
}
