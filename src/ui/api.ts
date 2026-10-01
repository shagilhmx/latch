/** Minimal JSON fetch helper shared by the UI action panels. */
export interface UiApiResponse<T> {
  status: number;
  body: T;
}

export async function api<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<UiApiResponse<T>> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = { message: text.slice(0, 200) };
    }
  }
  return { status: response.status, body: parsed as T };
}

/** Human-readable failure text for any API response. */
export function apiMessage(response: UiApiResponse<unknown>): string {
  const body = response.body as { message?: unknown; error?: unknown } | null;
  const message = body?.message ?? body?.error;
  return typeof message === "string" && message.length > 0
    ? message
    : `Request failed (HTTP ${response.status})`;
}
