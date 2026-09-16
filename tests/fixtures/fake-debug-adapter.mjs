/**
 * A stand-in debug adapter: the same Content-Length framing and the same message names as a real
 * one, with fixed answers, so the tests can prove launch, step, variables and stop without
 * debugpy or Node's inspector being involved.
 */
let buffer = Buffer.alloc(0), seq = 1;
const send = (message) => {
  const body = Buffer.from(JSON.stringify({ seq: seq++, ...message }), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
};
const respond = (request, body = {}) =>
  send({ type: "response", request_seq: request.seq, success: true, command: request.command, body });
const event = (name, body) => send({ type: "event", event: name, body });

let line = 4;
const stopHere = () => event("stopped", { reason: "breakpoint", threadId: 1, line });

function handle(request) {
  const { command } = request;
  if (command === "initialize") { respond(request, { supportsConfigurationDoneRequest: true }); event("initialized", {}); return; }
  if (command === "setBreakpoints") {
    respond(request, { breakpoints: (request.arguments.breakpoints ?? []).map((b) => ({ verified: true, line: b.line })) });
    return;
  }
  if (command === "launch") { respond(request); event("output", { output: "the program started\n" }); setTimeout(stopHere, 10); return; }
  if (command === "configurationDone") { respond(request); return; }
  if (command === "stackTrace") { respond(request, { stackFrames: [{ id: 7, name: "main", line }], totalFrames: 1 }); return; }
  if (command === "scopes") { respond(request, { scopes: [{ name: "Locals", variablesReference: 11 }] }); return; }
  if (command === "variables") {
    respond(request, { variables: [{ name: "total", value: "42", type: "int" }, { name: "name", value: "'ada'", type: "str" }] });
    return;
  }
  if (command === "next" || command === "stepIn" || command === "stepOut") {
    respond(request); line += 1; setTimeout(stopHere, 10); return;
  }
  if (command === "continue") { respond(request, { allThreadsContinued: true }); setTimeout(() => event("terminated", {}), 10); return; }
  if (command === "disconnect") { respond(request); setTimeout(() => process.exit(0), 5); return; }
  respond(request);
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
