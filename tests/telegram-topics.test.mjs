import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramAdapter } from '../dist/channels/telegram.js';

const base = { id: 'tg', token: 'fake', pollTimeoutSeconds: 0 };

test('forum updates retain distinct routing addresses and callbacks stay in their topic', async () => {
  const seen = [], sent = [];
  const updates = [
    { update_id: 1, message: { message_id: 11, message_thread_id: 7, text: 'one', from: { id: 5 }, chat: { id: -99, type: 'supergroup' } } },
    { update_id: 2, message: { message_id: 12, message_thread_id: 8, text: 'two', from: { id: 5 }, chat: { id: -99, type: 'supergroup' } } },
    { update_id: 3, callback_query: { id: 'press', data: 'yes', from: { id: 5 }, message: { message_id: 13, message_thread_id: 7, chat: { id: -99, type: 'supergroup' } } } },
  ];
  const fetch = async (url, init) => {
    const method = String(url).split('/').at(-1);
    if (method === 'getUpdates') { await new Promise((resolve) => setTimeout(resolve, 20)); return Response.json({ ok: true, result: updates.splice(0) }); }
    if (method === 'getMe') return Response.json({ ok: true, result: { id: 1, username: 'Bot' } });
    sent.push({ method, body: JSON.parse(init.body) });
    return Response.json({ ok: true, result: { message_id: 44 } });
  };
  const adapter = new TelegramAdapter({ ...base, fetch });
  await adapter.start(async (message) => { seen.push(message); });
  try {
    await new Promise((resolve, reject) => { const timer = setInterval(() => { if (seen.length === 3) { clearInterval(timer); resolve(); } }, 10); setTimeout(() => { clearInterval(timer); reject(new Error('updates timed out')); }, 1000); });
  } finally { await adapter.stop(); }
  assert.notEqual(seen[0].chatId, seen[1].chatId);
  assert.equal(seen[0].chatId, seen[2].chatId);
  assert.equal(seen[0].senderId, '5');
  await adapter.send(seen[0].chatId, 'reply', seen[0].messageId);
  await adapter.sendButtons(seen[1].chatId, 'approve?', [{ label: 'Yes', value: 'yes' }]);
  await adapter.sendTyping(seen[0].chatId);
  assert.deepEqual(sent.filter((x) => x.method !== 'answerCallbackQuery').map((x) => [x.body.chat_id, x.body.message_thread_id]), [[-99, 7], [-99, 8], [-99, 7]]);
});

test('files and voice replies target the physical forum chat and topic; ordinary chats remain unchanged', async () => {
  const sent = [];
  const adapter = new TelegramAdapter({ ...base, fetch: async (url, init) => { sent.push({ method: String(url).split('/').at(-1), body: init.body }); return Response.json({ ok: true, result: { message_id: 1 } }); } });
  await adapter.sendFile('-99:7', { name: 'a.txt', mediaType: 'text/plain', bytes: new Uint8Array([65]) });
  await adapter.sendVoice('-99:7', new Uint8Array([65]), 'audio/ogg');
  await adapter.send('42', 'plain');
  assert.deepEqual(sent.slice(0, 2).map((x) => [x.body.get('chat_id'), x.body.get('message_thread_id')]), [['-99', '7'], ['-99', '7']]);
  assert.deepEqual(JSON.parse(sent[2].body), { chat_id: 42, text: 'plain' });
});
