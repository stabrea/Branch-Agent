import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramAdapter } from '../dist/channels/telegram.js';

const file = { name: 'report.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode('report') };

test('Telegram document delivery requires a confirmed message id', async () => {
  const adapter = new TelegramAdapter({ id: 'telegram', token: 'test', fetch: async () =>
    new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }) });
  await assert.rejects(adapter.sendFile('42', file), /sendDocument.*message_id/i);
});

test('Telegram document delivery returns the confirmed message id', async () => {
  const adapter = new TelegramAdapter({ id: 'telegram', token: 'test', fetch: async () =>
    new Response(JSON.stringify({ ok: true, result: { message_id: 123 } }), { status: 200 }) });
  assert.equal(await adapter.sendFile('42', file), '123');
});
