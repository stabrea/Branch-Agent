# STATUS: CI flakes, round 2 (mac7/ci-flakes-2)

Checks run 35453102759 on trunk cc212bf5 failed four tests (macOS 1/2, macOS 2/2, Linux 2/2). Find the
root cause of each, fix the product when it is a product bug, otherwise make the test wait for the
condition. Also any other test that failed more than once in the last ~15 trunk Checks runs.

## Findings
- realtime-voice "a client on the run socket sends sound up…" (macOS, `database is not open`): PRODUCT
  BUG. The run socket's poll loop kept reading the task's events after the app had closed the
  database; nothing ends a run socket when the app closes, so a socket still open at shutdown read a
  closed database at its next turn. In the test the fixture closed the app before the client's close
  frame arrived. Reproduced every time (scratch script: open a run socket, close the store: "threw:
  database is not open").
- IRC "signs in with SASL…" (Linux, "SASL finished before the capability talk ended"): TEST FAKE, and
  a product bug behind it. The stand-in welcomed (001) on USER, in the middle of capability
  negotiation, which IRCv3 forbids; the client joined on that welcome, before the SASL token and
  CAP END, so the test's check raced its own polling. Recorded order with the old stand-in:
  `… USER | AUTHENTICATE PLAIN | JOIN #room | AUTHENTICATE <token> | CAP END`. With a server that
  holds registration until CAP END (as real ones do), a refused password was then hidden: the
  welcome after 904 + CAP END set the state back to "connected" and joined channels unsigned.
- ai-comments "one burst of changes becomes one task…" (macOS, b.js missing): TEST TIMING. The quiet
  time restarts on every change, so a first task without b.js means b.js's change reached the watcher
  more than the test's 60 ms after a.js's (FSEvents on a loaded runner). Same shape as the sibling
  watcher test fixed last round. Not reproducible here: on Windows the a.js → b.js gap is ~2 ms
  (3 × 100 traced runs, max 4.3 ms).
- Nostr "NIP-04 messages round-trip…" (macOS, "Missing expected exception"): TEST ASSUMPTION, plus a
  product gap. NIP-04 is AES-CBC with no MAC; the wrong key passes the padding check about 1 in 256
  (measured 67 / 20000) and returned noise instead of throwing. The product decoded that noise as
  text (with U+FFFD) and would have handed it on as a message.
- Other repeats in the last 25 trunk runs: source-hygiene "real credential" (2×) and the
  folder-trust / triggers-webhooks file crashes (diagnostic crash handler reading the closed store)
  are both fixed by e1c540b8, already on trunk; 81f9e022 was green after it. Q6 French / Q2 /
  NUL byte / static-assets / desktop* failures were in `verify` jobs on superseded commits, green since.

## Progress
- [x] ws: `pollRun` stops when `Store.isOpen` is false and closes the socket with a close frame.
      New test: a run socket open when the app closes ends cleanly (fails before: database is not open).
      The client test now waits for the socket's close and for the server loop to end.
- [x] IRC stand-in: ACKs account-tag, welcomes only on CAP END. SASL test also asserts JOIN after CAP END.
- [x] IRC product: 902/904/905 end the sign-in; the welcome that follows keeps "needs attention" and joins
      nothing. Wrong-password test now gets the welcome and checks both (fails before: state overwritten).
- [x] Nostr: `nip04Decrypt` decodes UTF-8 strictly (noise is refused); test checks 2000 fresh IVs never
      give the message back or U+FFFD text (fails before). 0 / 20000 wrong-key decrypts return now.
- [x] ai-comments: 400 ms quiet time (the watcher's default), waits 2 quiet times before asserting one task.
- [x] voice test: the close listener is added when the client is made. Added only at the end, it hung
      when the server had already ended the socket itself (task's 4 s passed): 3 of 3 loop copies hung
      under load; proved with maxMs 50 (old: hangs, new: passes).
- [x] loops, single test by name, 3 copies of each kind at once (machine loaded):
      before (cc212bf5): ai-comments 75/75, voice client 75/75, IRC SASL 75/75 — none reproduced here;
      the causes were shown instead by the scratch reproductions above (store close: throws every time;
      IRC line order: JOIN before the SASL token every time; NIP-04: 67 / 20000 wrong-key decrypts returned).
      after: ai-comments 75/75, all IRC tests 75/75 + 45/45, NIP-04 75/75 (2000 wrong keys each),
      all run-socket voice tests 75/75 (after the close-listener fix).
- [ ] merge into trunk
