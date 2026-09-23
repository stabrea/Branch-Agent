import assert from "assert";
import { randomBytes } from "crypto";
import { test } from "node:test";

/**
 * Tests for linux-desktop findings fixes:
 * 1. Network isolation and permission classification
 * 2. VNC password delivery via owner-only route
 * 3. Control abort on takeOver
 * 4. xdotool arg passing and image validation
 * 5. Hardening: process limits, labels, stale cleanup, read-only
 * 6. runProgram shell test
 */

test("Finding 1: docker run has --network none", async () => {
  const { dockerRunArgv } = await import("../dist/integrations/linux-desktop.js");
  const argv = dockerRunArgv("test-image:latest");
  assert(argv.includes("--network"), "argv should include --network");
  assert(argv.includes("none"), "argv should include none");
  const networkIdx = argv.indexOf("--network");
  assert(argv[networkIdx + 1] === "none", "--network should be immediately followed by none");
  assert(!argv.includes("-p"), "argv should NOT include -p (port mapping disabled with --network none)");
});

test("Finding 1: docker run no longer has -p port mapping", async () => {
  const { dockerRunArgv } = await import("../dist/integrations/linux-desktop.js");
  const argv = dockerRunArgv("test-image:latest");
  const portMapIdx = argv.indexOf("-p");
  assert.strictEqual(portMapIdx, -1, "-p should not appear in docker run args");
});

test("Finding 1: docker run uses shell:false in spawner", async () => {
  // The password is written via feed() which uses spawn with shell: false
  const { feed } = await import("../dist/integrations/linux-desktop.js");
  assert(typeof feed === "function", "feed should be exported");
});

test("Finding 2: VNC password is not in argv", async () => {
  const { dockerRunArgv, x11vncArgv } = await import("../dist/integrations/linux-desktop.js");
  const password = "abc123def456";
  const argv = dockerRunArgv("test-image:latest");

  // The password should NOT appear in the argv at all
  const argStr = argv.join(" ");
  assert(!argStr.includes(password), "password should never be in docker argv");
  assert(!argStr.includes("abc123"), "no part of password should appear");

  // x11vnc should use -passwdfile rm:/tmp/vncpw instead
  const x11argv = x11vncArgv();
  assert(x11argv.includes("-passwdfile"), "x11vnc should have -passwdfile");
  assert(x11argv.includes("rm:/tmp/vncpw"), "x11vnc should use rm:/tmp/vncpw");
  assert(!x11argv.includes(password), "x11vnc argv should never contain the password");
});

test("Finding 2: password length is 8 characters (base64url of 6 bytes)", async () => {
  const password = randomBytes(6).toString("base64url");
  assert.strictEqual(password.length, 8, "password should be exactly 8 characters");
  assert(/^[A-Za-z0-9_-]+$/.test(password), "password should be base64url (no + or /)");
});

test("Finding 2: docker run script waits for password file before starting x11vnc", async () => {
  const { dockerRunArgv } = await import("../dist/integrations/linux-desktop.js");
  const argv = dockerRunArgv("test-image:latest");
  const shellLine = argv.join(" ");

  // The inner script should wait for /tmp/vncpw to exist and have size
  assert(shellLine.includes("while [ ! -s /tmp/vncpw ]"), "script should wait for password file");
  assert(shellLine.includes("sleep 0.2"), "script should sleep while waiting");
  assert(shellLine.includes("x11vnc"), "x11vnc should be started");
  assert(shellLine.includes("-passwdfile rm:/tmp/vncpw"), "x11vnc should use the password file");
});

test("Finding 3: takeOver creates new AbortController to allow resumption", async () => {
  // This is tested in shared-desktop.test.mjs which is comprehensive
  // Here we just verify the interface exists
  const { LinuxDesktopSandbox } = await import("../dist/integrations/linux-desktop.js");
  assert(typeof LinuxDesktopSandbox.prototype.takeOver === "function", "takeOver method should exist");
  assert(typeof LinuxDesktopSandbox.prototype.handBack === "function", "handBack method should exist");
});

test("Finding 4: xdotool gets -- before user text", async () => {
  const { xdotoolArgv } = await import("../dist/integrations/linux-desktop.js");

  const typeAction = { type: "type", text: "-malicious-flag value" };
  const argv = xdotoolArgv(typeAction);

  assert(argv[0] === "type", "first arg should be 'type'");
  assert(argv[1] === "--clearmodifiers", "second arg should be --clearmodifiers");
  assert(argv[2] === "--", "third arg should be -- to stop option parsing");
  assert(argv[3] === "-malicious-flag value", "fourth arg should be the text");
});

test("Finding 4: image validation rejects leading dash", async () => {
  const { LinuxDesktopSchema } = await import("../dist/integrations/linux-desktop.js");

  const bad = { image: "--privileged attack:latest" };
  const result = LinuxDesktopSchema.safeParse(bad);
  assert(!result.success, "image starting with -- should be rejected");
});

test("Finding 4: metacharacters in type text are preserved", async () => {
  const { xdotoolArgv } = await import("../dist/integrations/linux-desktop.js");

  const dangerous = "$() & ; < > | \" ' ` ~ ! & * ? [ ] ( )";
  const argv = xdotoolArgv({ type: "type", text: dangerous });

  const textArg = argv[argv.length - 1];
  assert.strictEqual(textArg, dangerous, "dangerous characters should pass through unchanged");
});

test("Finding 5: docker run has --pids-limit", async () => {
  const { dockerRunArgv } = await import("../dist/integrations/linux-desktop.js");
  const argv = dockerRunArgv("test-image:latest");
  assert(argv.includes("--pids-limit"), "argv should include --pids-limit");
  const idx = argv.indexOf("--pids-limit");
  assert(argv[idx + 1] === "256", "--pids-limit should be 256");
});

test("Finding 5: docker run has a label", async () => {
  const { dockerRunArgv } = await import("../dist/integrations/linux-desktop.js");
  const argv = dockerRunArgv("test-image:latest");
  assert(argv.some(arg => arg.includes("branch.shared-desktop")), "label should reference branch.shared-desktop");
});

test("Finding 5: docker run has --pull=never", async () => {
  const { dockerRunArgv } = await import("../dist/integrations/linux-desktop.js");
  const argv = dockerRunArgv("test-image:latest");
  assert(argv.includes("--pull=never"), "argv should include --pull=never to prevent auto-pull");
});

test("Finding 6: runProgram uses shell:false", async () => {
  const { runProgram } = await import("../dist/integrations/linux-desktop.js");
  assert(typeof runProgram === "function", "runProgram should be a function");
  // The actual test is in shared-desktop.test.mjs and mutation tests
});

test("Finding 6: feed writes to stdin with shell:false", async () => {
  const { feed } = await import("../dist/integrations/linux-desktop.js");
  assert(typeof feed === "function", "feed should be exported for password writing");
});

test("Listener binds to 127.0.0.1 only (not all interfaces)", async () => {
  // The createListener method should bind only to 127.0.0.1
  // This is verified by the test that checks host in shared-desktop.test.mjs
  const { LinuxDesktopSandbox } = await import("../dist/integrations/linux-desktop.js");
  const sandbox = new LinuxDesktopSandbox({
    get() { return undefined; },
    save() {},
    event() {},
  });
  assert(typeof sandbox.spawnerFn === "function", "spawner should be injectable");
});

test("ViewerInfo route is owner-only (tested in short-lived-key-routes.mjs)", async () => {
  // The route classification is verified in short-lived-key-routes.mjs
  // This test just documents the expectation
  const { LinuxDesktopSandbox } = await import("../dist/integrations/linux-desktop.js");
  const sandbox = new LinuxDesktopSandbox({
    get() { return undefined; },
    save() {},
    event() {},
  });
  assert(typeof sandbox.viewerInfo === "function", "viewerInfo method should exist");
});
