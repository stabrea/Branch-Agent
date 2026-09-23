import { pinnedFetch } from '../pinned-fetch.js';

/**
 * Bound MCP HTTP bodies before the SDK's JSON/SSE parsers receive them. Sent through the fetch for
 * checked requests, so a request the network policy checked stays with the addresses it judged.
 */
export const boundedFetch: typeof fetch = async (input, init) => {
  const signals = [AbortSignal.timeout(30000)];
  if (init?.signal) signals.push(init.signal);
  const response = await pinnedFetch(input, { ...init, redirect: 'error', signal: AbortSignal.any(signals) });
  if (!response.body) return response;
  const reader = response.body.getReader();
  let bytes = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) { reader.releaseLock(); controller.close(); return; }
        bytes += part.value.byteLength;
        if (bytes > 1048576) throw new Error('MCP HTTP response exceeds 1 MiB');
        controller.enqueue(part.value);
      } catch (error) {
        await reader.cancel().catch(() => undefined); controller.error(error);
      }
    },
    cancel: reason => reader.cancel(reason),
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
};
