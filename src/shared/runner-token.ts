/**
 * Shared protocol for runner (system-surface) authentication.
 *
 * Imported by BOTH sides of the boundary — the Worker (policy + queue
 * consumer) and the client side (integration runner, Agent SDK) — so the
 * header name and the comparison rule live in exactly one place.
 */
export const RUNNER_TOKEN_HEADER = "x-latch-runner-token";

/** Headers to attach to an outbound system request, when a token is set. */
export function runnerHeaders(token: string | null | undefined): Record<string, string> {
  return typeof token === "string" && token.length > 0
    ? { [RUNNER_TOKEN_HEADER]: token }
    : {};
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

/**
 * Constant-time token comparison: both sides are hashed first, so neither
 * the length nor the byte content of the configured secret can leak through
 * response timing.
 */
export async function tokenEquals(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256(a), sha256(b)]);
  let diff = left.length ^ right.length;
  for (let i = 0; i < left.length; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}
