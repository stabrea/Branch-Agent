/**
 * Creates an API client.
 * @param {{ baseUrl: string, timeoutMs?: number, retries?: number }} options
 */
export function createClient({ baseUrl, timeoutMs = 5000, retries = 2 }) {
  if (!baseUrl) throw new Error("baseUrl is required");
  return { baseUrl, timeoutMs, retries };
}
