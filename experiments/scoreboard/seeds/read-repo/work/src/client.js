import { nextDelay, shouldRetry } from "./backoff.js";
import { Limiter } from "./limiter.js";

const limiter = new Limiter();

export async function send(request, fetcher = fetch) {
  if (!limiter.take(request.key)) throw new Error("over the limit");
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await fetcher(request.url);
    if (!shouldRetry(response.status)) return response;
    await new Promise((resolve) => setTimeout(resolve, nextDelay(attempt)));
  }
  throw new Error("gave up");
}
