/**
 * A stand-in for a command line that stays open: it reads one line at a time from its input and
 * answers each one, counting as it goes, so a test can tell one long-lived program from two short
 * ones. Nothing here reaches the network and nothing opens a window.
 */
import { createInterface } from 'node:readline';

let count = 0;
process.stdout.write(`ready in ${process.cwd()}\n`);
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const text = line.trim();
  if (text === 'exit') { lines.close(); process.exit(0); }
  count += 1;
  process.stdout.write(`${count} ${text} pid=${process.pid}\n`);
});
lines.on('close', () => process.exit(0));
// Never outlive the test run, whatever happens to the parent.
setTimeout(() => process.exit(0), 60000).unref();
