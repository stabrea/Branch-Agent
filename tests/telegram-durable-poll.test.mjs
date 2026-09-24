import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { TelegramAdapter } from '../dist/index.js';

const update = (id) => ({ update_id: id, message: { message_id: id, text: String(id), from: { id: 42, first_name: 'A' }, chat: { id: 42, type: 'private' } } });
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(10); }
  assert.fail('timed out waiting for poll');
}

test('Telegram server acknowledgement never crosses unfinished updates; restart replays them', async (t) => {
  const pending = [update(10), update(11), update(12)];
  const offsets = [];
  let saved = 0;
  const position = { load: () => saved, save: (value) => { saved = value; } };
  const fakeFetch = async (url, init) => {
    const method = url.split('/').pop();
    if (method === 'getMe') return { json: async () => ({ ok: true, result: { id: 1, is_bot: true, username: 'TestBot' } }) };
    assert.equal(method, 'getUpdates');
    const offset = JSON.parse(init.body).offset;
    offsets.push(offset);
    // Telegram deletes all lower updates when it receives this offset, not when the client saves.
    while (pending.length && pending[0].update_id < offset) pending.shift();
    await delay(5);
    return { json: async () => ({ ok: true, result: [...pending] }) };
  };
  const options = { id: 'telegram', token: 'fake', fetch: fakeFetch, position, pollTimeoutSeconds: 1 };
  let finish10, finish11;
  const delivered = [];
  const first = new TelegramAdapter(options);
  await first.start(async (message) => {
    delivered.push(message.text);
    if (message.text === '10') await new Promise((resolve) => { finish10 = resolve; });
    if (message.text === '11') await new Promise((resolve) => { finish11 = resolve; });
  });
  t.after(async () => { finish10?.(); finish11?.(); await first.stop(); });
  await until(() => delivered.length === 3 && offsets.length >= 3);
  assert.deepEqual(delivered, ['10', '11', '12'], 'repeat polls do not dispatch duplicates');
  assert.ok(offsets.every((offset) => offset <= 10), 'server has not acknowledged unfinished 10');
  assert.equal(saved, 10);
  finish10();
  await until(() => saved === 11 && offsets.includes(11));
  assert.ok(pending.some((item) => item.update_id === 11));
  assert.ok(!offsets.includes(12), 'unfinished 11 is not acknowledged despite 12 settling');
  await first.stop(); // simulate process exit while 11 is still in flight
  const replay = [];
  const second = new TelegramAdapter(options);
  t.after(() => second.stop());
  await second.start(async (message) => { replay.push(message.text); });
  await until(() => replay.length >= 2);
  assert.deepEqual(replay, ['11', '12'], 'restart replays unfinished and later settled work');
  await until(() => saved === 13 && offsets.includes(13));
  finish11();
});

test('failed durable position write cannot acknowledge an update, then retries', async (t) => {
  const pending = [update(30)];
  const offsets = [];
  let saved = 0;
  let fail = true;
  const position = { load: () => saved, save: (value) => {
    if (fail) throw new Error('disk unavailable');
    saved = value;
  } };
  const fakeFetch = async (url, init) => {
    const method = url.split('/').pop();
    if (method === 'getMe') return { json: async () => ({ ok: true, result: { id: 1, is_bot: true, username: 'TestBot' } }) };
    const offset = JSON.parse(init.body).offset;
    offsets.push(offset);
    while (pending.length && pending[0].update_id < offset) pending.shift();
    await delay(5);
    return { json: async () => ({ ok: true, result: [...pending] }) };
  };
  const received = [];
  const adapter = new TelegramAdapter({ id: 'telegram', token: 'fake', fetch: fakeFetch, position, pollTimeoutSeconds: 1 });
  t.after(() => adapter.stop());
  await adapter.start(async (message) => { received.push(message.text); });
  await until(() => received.length === 1 && offsets.length >= 3);
  assert.ok(offsets.every((offset) => offset <= 30));
  assert.equal(saved, 0);
  fail = false;
  await until(() => saved === 31 && offsets.includes(31));
  assert.deepEqual(received, ['30']);
});
