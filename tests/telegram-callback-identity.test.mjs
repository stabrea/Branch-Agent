import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramAdapter } from '../dist/channels/telegram.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await tick(); }
  assert.fail('callback did not arrive');
}

test('separate presses of the same keyboard remain distinct', async () => {
  const presses = [];
  const acknowledgements = [];
  const outgoing = [];
  const chat = { id: 501, type: 'private' };
  const from = { id: 42, first_name: 'Alice' };
  const callback = (id) => ({ id, data: 'y:' + 'a'.repeat(32), from, message: { message_id: 11, chat } });
  let batch = [
    { update_id: 2, callback_query: callback('cb1') },
    { update_id: 3, callback_query: callback('cb2') },
  ];
  const adapter = new TelegramAdapter({ id: 'telegram', token: 'test', pollTimeoutSeconds: 1,
    fetch: async (url, options) => {
      const method = String(url).split('/').at(-1);
      if (method === 'getMe') return new Response(JSON.stringify({ ok: true, result: { id: 1, username: 'test' } }));
      if (method === 'answerCallbackQuery') acknowledgements.push(JSON.parse(options.body).callback_query_id);
      if (method === 'sendMessage') outgoing.push(JSON.parse(options.body));
      const result = method === 'getUpdates' ? batch.splice(0) : true;
      if (method === 'getUpdates' && !result.length) await tick();
      return new Response(JSON.stringify({ ok: true, result }));
    },
  });
  try {
    await adapter.start(async message => { presses.push(message); });
    await until(() => presses.length >= 2);
    assert.deepEqual(presses.map(p => p.messageId), ['cb1', 'cb2']);
    assert.deepEqual(presses.map(p => p.text), ['y:' + 'a'.repeat(32), 'y:' + 'a'.repeat(32)]);
    await until(() => acknowledgements.length >= 2);
    assert.deepEqual(acknowledgements, ['cb1', 'cb2']);
    await adapter.send('501', 'That button is stale', presses[1].messageId);
    assert.equal(outgoing[0].reply_parameters, undefined, 'callback id is never sent as an invalid Telegram message id');
  } finally { await adapter.stop(); }
});
