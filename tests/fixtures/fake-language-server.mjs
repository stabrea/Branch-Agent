/**
 * A stand-in language server: the same Content-Length framing and the same message names as a real
 * one, with fixed answers. It lets the tests prove the client's framing, its waiting for answers
 * and its turning a rename into a change set, without any language server being installed.
 */
let buffer = Buffer.alloc(0);
const send = (message) => {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
};
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const at = (line, character, length) => ({
  start: { line, character },
  end: { line, character: character + length },
});

let lastUri = "";

function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    reply(id, { capabilities: { renameProvider: true, hoverProvider: true, referencesProvider: true, definitionProvider: true } });
    return;
  }
  if (method === "initialized") return;
  if (method === "textDocument/didOpen") {
    lastUri = params.textDocument.uri;
    send({
      jsonrpc: "2.0", method: "textDocument/publishDiagnostics",
      params: {
        uri: lastUri,
        diagnostics: [{ range: at(1, 0, 5), severity: 1, message: "total is never used", source: "fake" }],
      },
    });
    // A real server also asks the editor questions; the client must answer rather than hang.
    send({ jsonrpc: "2.0", id: 9001, method: "workspace/configuration", params: { items: [] } });
    return;
  }
  if (method === "textDocument/definition") { reply(id, { uri: lastUri, range: at(0, 13, 5) }); return; }
  if (method === "textDocument/references") {
    reply(id, [{ uri: lastUri, range: at(0, 13, 5) }, { uri: lastUri, range: at(1, 12, 5) }]);
    return;
  }
  if (method === "textDocument/hover") { reply(id, { contents: { kind: "plaintext", value: "const total: number" } }); return; }
  if (method === "textDocument/rename") {
    reply(id, { changes: { [lastUri]: [{ range: at(0, 13, 5), newText: params.newName }, { range: at(1, 12, 5), newText: params.newName }] } });
    return;
  }
  if (method === "shutdown") { reply(id, null); return; }
  if (method === "exit") { process.exit(0); }
  if (id !== undefined) reply(id, null);
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const split = buffer.indexOf("\r\n\r\n");
    if (split < 0) return;
    const length = Number(/content-length:\s*(\d+)/i.exec(buffer.toString("ascii", 0, split))?.[1]);
    if (buffer.length < split + 4 + length) return;
    const body = buffer.toString("utf8", split + 4, split + 4 + length);
    buffer = buffer.subarray(split + 4 + length);
    handle(JSON.parse(body));
  }
});
