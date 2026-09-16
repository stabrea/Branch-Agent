import { setTimeout as wait } from "node:timers/promises";
import { z } from "zod";
import { ProviderStreamError } from "./contracts.js";

const quotaCodes = [
  "insufficient_quota",
  "billing_not_active",
  "billing_hard_limit_reached",
  "billing_error",
  "credit_balance_exhausted",
  "spend_limit_exceeded",
  "monthly_spend_limit_exceeded",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
] as const;
const knownCodes = [
  ...quotaCodes,
  "rate_limit_exceeded",
  "rate_limit_error",
  "slow_down",
] as const;
export type ProviderErrorCode = (typeof knownCodes)[number];

/** A rejected HTTP request; no successful completion body has been consumed. */
export class ProviderHttpError extends Error {
  override name = "ProviderHttpError";
  readonly code: ProviderErrorCode | undefined;
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
    code?: string,
    readonly classificationAvailable = true,
    readonly retryAfterRecognized = true,
  ) {
    const safeCode = knownCodes.find((known) => known === code);
    super(
      `Provider HTTP ${status}${safeCode ? ` (${safeCode})` : ""}; check endpoint, model, credential, and quota`,
    );
    this.code = safeCode;
  }
}

export const RetryPolicySchema = z
  .object({
    maxRetries: z.number().int().min(0).max(2).default(2),
    baseDelayMs: z.number().int().min(0).max(5000).default(250),
    maxDelayMs: z.number().int().min(0).max(5000).default(5000),
  })
  .strict()
  .refine(
    (policy) => policy.baseDelayMs <= policy.maxDelayMs,
    "Base retry delay must not exceed maximum delay",
  );
export type RetryPolicyInput = z.input<typeof RetryPolicySchema>;
export type RetryPolicy = Readonly<z.output<typeof RetryPolicySchema>>;
export const parseRetryPolicy = (input: RetryPolicyInput = {}): RetryPolicy =>
  Object.freeze(RetryPolicySchema.parse(input));

export function parseRetryAfter(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim()))
    return Math.min(Number.MAX_SAFE_INTEGER, Number(value.trim()) * 1000);
  if (
    !/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      value.trim(),
    )
  )
    return undefined;
  const deadline = Date.parse(value);
  if (!Number.isFinite(deadline) || new Date(deadline).toUTCString() !== value.trim())
    return undefined;
  return Math.max(0, deadline - now);
}

export async function rejectedHttpResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<ProviderHttpError> {
  const details = await readErrorCodes(response);
  signal?.throwIfAborted();
  const { codes } = details;
  const code =
    codes.find((value) => quotaCodes.some((quota) => quota === value)) ??
    codes.find((value) => knownCodes.some((known) => known === value));
  const header = response.headers.get("retry-after"),
    retryAfter = parseRetryAfter(header);
  return new ProviderHttpError(
    response.status,
    retryAfter,
    code,
    details.complete,
    header === null || retryAfter !== undefined,
  );
}

interface ErrorDetails {
  codes: string[];
  complete: boolean;
}
const unavailableErrorDetails = (): ErrorDetails => ({
  codes: [],
  complete: false,
});
async function readErrorCodes(response: Response): Promise<ErrorDetails> {
  if (!response.body) return unavailableErrorDetails();
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0,
    timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, 1000);
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 16384) return unavailableErrorDetails();
      chunks.push(next.value);
    }
    return timedOut
      ? unavailableErrorDetails()
      : parseErrorCodes(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return unavailableErrorDetails();
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
function parseErrorCodes(body: string): ErrorDetails {
  const shape = z.object({
    error: z.object({
      code: z.string().optional(),
      type: z.string().optional(),
    }),
  });
  const parsed = shape.safeParse(JSON.parse(body));
  return parsed.success
    ? {
        codes: [parsed.data.error.code, parsed.data.error.type].filter(
          (value): value is string => value !== undefined,
        ),
        complete: true,
      }
    : unavailableErrorDetails();
}

/** True for failures where trying another configured model is reasonable: retryable HTTP classes or a failed connection. */
export function fallbackEligible(error: unknown): boolean {
  if (error instanceof Error && error.name === "StallError") return true;
  if (retryableHttpError(error)) return true;
  const cause = error instanceof ProviderStreamError ? error.cause : error;
  return cause instanceof TypeError && /fetch failed/i.test(cause.message);
}

function retryableHttpError(error: unknown): ProviderHttpError | undefined {
  for (
    let depth = 0;
    error instanceof ProviderStreamError && depth < 4;
    depth++
  ) {
    if (error.estimatedOutput > 0 || error.usage !== undefined)
      return undefined;
    error = error.cause;
  }
  if (
    !(error instanceof ProviderHttpError) ||
    !error.retryAfterRecognized ||
    quotaCodes.some((code) => code === error.code)
  )
    return undefined;
  if (![408, 429, 500, 502, 503, 504, 529].includes(error.status))
    return undefined;
  if (error.status === 429 && !error.classificationAvailable) return undefined;
  if (
    error.status === 429 &&
    error.retryAfterMs === undefined &&
    error.code !== "rate_limit_exceeded" &&
    error.code !== "slow_down"
  )
    return undefined;
  return error;
}

export function planRetry(
  error: unknown,
  retriesUsed: number,
  policy: RetryPolicy,
): { status: number; delayMs: number } | undefined {
  const failure = retryableHttpError(error);
  if (!failure || retriesUsed >= policy.maxRetries) return undefined;
  const delayMs = Math.max(
    policy.baseDelayMs * 2 ** retriesUsed,
    failure.retryAfterMs ?? 0,
  );
  if (!Number.isFinite(delayMs) || delayMs > policy.maxDelayMs)
    return undefined;
  return { status: failure.status, delayMs };
}

export async function waitForRetry(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  await wait(delayMs, undefined, { signal });
}
