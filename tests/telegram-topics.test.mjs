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

test('files sent inside a forum topic are stored with cleaned address in the folder name', async () => {
  const runs = [];
  let writeCalls = [];
  const runtime = {
    owner: 'owner',
    registry: { permissions: () => [] },
    tracer: { startAfter: () => ({ end() {} }) },
    artifacts: {
      write: async (id, name, _type, bytes) => {
        writeCalls.push({ id, name });
        return { path: `/artifacts/${id}/${name}`, bytes: bytes.byteLength, sha256: 'fake', mediaType: _type };
      }
    },
    run: async options => { runs.push(options); return { id: 'run', sessionId: 'session', status: 'completed', output: 'done' }; }
  };
  const store = { ownsSession: () => false, get: () => undefined, save: () => {}, event: () => {}, events: () => [], onEvent: () => () => {}, list: () => [] };
  const { ChannelRouter } = await import('../dist/channels/router.js');
  const router = new ChannelRouter(store, runtime, 100000);

  let downloaded = 0;
  const fetch = async url => {
    const path = String(url);
    if (path.endsWith('/getMe')) return Response.json({ ok: true, result: { id: 1, is_bot: true, username: 'branch' } });
    if (path.endsWith('/getUpdates')) { await new Promise(resolve => setTimeout(resolve, 5)); return Response.json({ ok: true, result: [] }); }
    if (path.endsWith('/getFile')) { downloaded++; return Response.json({ ok: true, result: { file_path: 'docs/file', file_size: 3 } }); }
    if (path.endsWith('/docs/file')) return new Response(new Uint8Array([1, 2, 3]));
    if (path.endsWith('/sendMessage')) return Response.json({ ok: true, result: { message_id: 10 } });
    throw Error(path);
  };
  const adapter = new TelegramAdapter({ id: 'tg', token: 'fake', fetch, pollTimeoutSeconds: 0 });
  try {
    await router.attach(adapter, { activation: 'always', pairing: false, allowlist: ['7'] });

    const message = adapter.inbound({
      message_id: 1,
      message_thread_id: 45,
      chat: { id: -1001234567890, type: 'supergroup' },
      from: { id: 7 },
      document: { file_id: 'd', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 3 }
    });

    await router.handle(message);

    // Verify that the artifact folder name has the colon replaced with underscore
    assert.equal(runs.length, 1, 'Should have run');
    const writCall = writeCalls.find(w => w.id.startsWith('inbound-tg-'));
    assert.ok(writCall, 'Should have written artifact');
    assert.equal(writCall.id, 'inbound-tg-1001234567890_45', 'Folder name should have invalid characters removed/replaced');
    assert.ok(runs[0].prompt.includes('report.pdf'), 'Prompt should include clean filename');
  } finally {
    await router.detachAll();
  }
});

test('router rejects files larger than 8 MB with clear message', async () => {
  const runs = [];
  const deliveries = [];
  const runtime = {
    owner: 'owner',
    registry: { permissions: () => [] },
    tracer: { startAfter: () => ({ end() {} }) },
    artifacts: {
      write: async () => { throw new Error('Should not be called'); }
    },
    run: async options => { runs.push(options); return { id: 'run', sessionId: 'session', status: 'completed', output: 'done' }; }
  };
  const store = { ownsSession: () => false, get: () => undefined, save: () => {}, event: () => {}, events: () => [], onEvent: () => () => {}, list: () => [] };
  const { ChannelRouter } = await import('../dist/channels/router.js');
  const router = new ChannelRouter(store, runtime, 100000);

  // Mock deliveries to capture messages
  const originalDeliver = router.deliver.bind(router);
  router.deliver = async (channel, chatId, text, ...args) => {
    deliveries.push({ channel, chatId, text });
    return { messageId: 'test', queued: 0 };
  };

  const fetch = async url => {
    const path = String(url);
    if (path.endsWith('/getMe')) return Response.json({ ok: true, result: { id: 1, is_bot: true, username: 'branch' } });
    if (path.endsWith('/getUpdates')) { await new Promise(resolve => setTimeout(resolve, 5)); return Response.json({ ok: true, result: [] }); }
    if (path.endsWith('/sendMessage')) return Response.json({ ok: true, result: { message_id: 10 } });
    throw Error(path);
  };
  const adapter = new TelegramAdapter({ id: 'tg', token: 'fake', fetch, pollTimeoutSeconds: 0 });
  try {
    await router.attach(adapter, { activation: 'always', pairing: false, allowlist: ['7'] });

    const message = adapter.inbound({
      message_id: 1,
      chat: { id: 5, type: 'private' },
      from: { id: 7 },
      document: { file_id: 'd', file_name: 'large.pdf', mime_type: 'application/pdf', file_size: 10 * 1024 * 1024 }
    });

    await router.handle(message);

    // Should not have started a run
    assert.equal(runs.length, 0, 'Should not run for oversized file');
    // Should have sent an error message about 8 MB limit
    const errorMsg = deliveries.find(d => d.text.includes('8 MB'));
    assert.ok(errorMsg, 'Should send message about 8 MB limit');
  } finally {
    await router.detachAll();
  }
});
