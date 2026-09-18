const BASE_MS = 250;
const CEILING_MS = 30000;

// How long to wait before attempt number `attempt` (1 = the first retry).
export function nextDelay(attempt, jitter = Math.random) {
  const raw = Math.min(BASE_MS * 2 ** (attempt - 1), CEILING_MS);
  return Math.round(raw * (0.5 + jitter() / 2));
}

export function shouldRetry(status) {
  return status === 429 || (status >= 500 && status < 600);
}
