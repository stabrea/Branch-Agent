import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
if (mode === 'build') {
  mkdirSync('out', { recursive: true });
  writeFileSync('out/result.json', JSON.stringify([1, 2, 3].map(value => value * value)));
  console.log(JSON.stringify({ built: 'out/result.json', cwd: process.cwd(), args: process.argv.slice(3) }));
} else if (mode === 'env') {
  console.log(JSON.stringify(process.env));
} else if (mode === 'fail') {
  console.log('before failure'); console.error('fixture compilation failed'); process.exitCode = 7;
} else if (mode === 'flood') {
  const flood = () => { while (process.stdout.write('x'.repeat(4096))) {} process.stdout.once('drain', flood); };
  flood();
} else if (mode === 'invalid-bytes') {
  process.stdout.write(Buffer.alloc(Number(process.argv[3]), 255));
  process.stderr.write(Buffer.alloc(20, 255));
} else if (mode === 'split-unicode') {
  const bytes = Buffer.from('☃🙂'.repeat(20));
  for (let index = 0; index < bytes.length; index++) {
    process.stdout.write(bytes.subarray(index, index + 1));
    await new Promise(resolve => setImmediate(resolve));
  }
  process.stderr.write('é'.repeat(100));
} else if (mode === 'unicode-limit') {
  process.stderr.write('ok');
  await new Promise(resolve => setTimeout(resolve, 20));
  process.stdout.write('☃'.repeat(100));
} else if (mode === 'tree' || mode === 'orphan') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'hold'],
    { shell: false, windowsHide: true, detached: mode === 'orphan' && process.platform === 'win32',
      env: process.env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  child.once('message', () => {
    writeFileSync(process.argv[3], JSON.stringify({ parent: process.pid, child: child.pid }));
    if (mode === 'orphan') { child.disconnect(); child.unref(); process.exit(0); }
  });
  setTimeout(() => process.exit(0), 20000);
} else if (mode === 'hold') {
  process.stdout.write('child ready\n');
  process.send?.('ready');
  setTimeout(() => process.exit(0), 20000);
} else throw new Error('Unknown fixture mode');
