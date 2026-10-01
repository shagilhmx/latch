import type { ApiError } from "../shared/types";

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function apiError(
  status: number,
  error: string,
  message: string,
  extra: Partial<ApiError> = {},
): Response {
  return json({ error, message, ...extra } satisfies ApiError, status);
}

/** Thrown by route handlers; the fetch wrapper converts it to a response. */
export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Partial<ApiError> = {},
  ) {
    super(message);
    this.name = "HttpProblem";
  }
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error("body must be a JSON object");
    }
    return body as Record<string, unknown>;
  } catch {
    throw new HttpProblem(400, "invalid_body", "Request body must be a JSON object");
  }
}

export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpProblem(400, "invalid_field", `"${field}" must be a non-empty string`);
  }
  return value.trim();
}

export function requireStringArray(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== "string")) {
    throw new HttpProblem(400, "invalid_field", `"${field}" must be a non-empty string array`);
  }
  return value as string[];
}
