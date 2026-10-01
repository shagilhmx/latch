/**
 * Authentication: signed session cookies, GitHub OAuth, and the /api/auth/*
 * routes. The resolved actor is attached to every Coordinator request as an
 * internal header — the Coordinator never trusts client-supplied identity.
 *
 * With `AUTH_SECRET` set (deployed), requests without a valid cookie are
 * anonymous and mutations are refused (see authz.ts). Without it (local
 * dev / tests) every request is attributed to the built-in `dev` actor, and
 * `POST /api/auth/dev` switches identity for exercising permissions.
 */
import { DEV_ACTOR, authMode, type Actor, type AuthMode } from "./authz";
import { apiError, json, readBody, requireString } from "./http";

export const SESSION_COOKIE = "latch_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const DEV_COOKIE_SECRET = "latch-dev-session-secret";

export interface ResolvedActor {
  mode: AuthMode;
  actor: Actor | null;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return atob(padded + pad);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Sign a session value: `v1.<payload-b64url>.<sig-b64url>`. */
export async function signSession(
  actor: Actor,
  secret: string,
  now: number = Date.now(),
): Promise<string> {
  const payload = {
    uid: actor.id,
    login: actor.login,
    av: actor.avatarUrl ?? null,
    exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
  };
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded));
  return `v1.${encoded}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Verify a session value; returns null for missing/tampered/expired. */
export async function verifySession(
  value: string | undefined | null,
  secret: string,
  now: number = Date.now(),
): Promise<Actor | null> {
  if (value === undefined || value === null) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, encoded, signature] = parts;
  if (encoded === undefined || signature === undefined) return null;

  try {
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      new Uint8Array(base64UrlDecode(signature).split("").map((c) => c.charCodeAt(0))),
      new TextEncoder().encode(encoded),
    );
    if (!valid) return null;

    const payload = JSON.parse(base64UrlDecode(encoded)) as {
      uid?: unknown;
      login?: unknown;
      av?: unknown;
      exp?: unknown;
    };
    if (
      typeof payload.uid !== "string" ||
      typeof payload.login !== "string" ||
      typeof payload.exp !== "number" ||
      payload.exp * 1000 <= now
    ) {
      return null;
    }
    return {
      id: payload.uid,
      login: payload.login,
      ...(typeof payload.av === "string" ? { avatarUrl: payload.av } : {}),
    };
  } catch {
    return null;
  }
}

function sessionSecret(env: { AUTH_SECRET?: string | undefined }): string {
  return env.AUTH_SECRET !== undefined && env.AUTH_SECRET.length > 0
    ? env.AUTH_SECRET
    : DEV_COOKIE_SECRET;
}

function cookieHeader(value: string, origin: string, maxAge: number): string {
  const secure = origin.startsWith("https://") ? "; Secure" : "";
  return `${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/** Resolve the acting identity from the session cookie (never from headers). */
export async function resolveActor(request: Request, env: Env): Promise<ResolvedActor> {
  const mode = authMode(env);
  const cookie = request.headers.get("cookie") ?? undefined;
  const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]*)`).exec(cookie ?? "");
  const value = match?.[1];
  const actor = await verifySession(value !== undefined ? decodeURIComponent(value) : null, sessionSecret(env));
  if (mode === "github") return { mode, actor };
  return { mode, actor: actor ?? DEV_ACTOR };
}

// ------------------------------------------------------------ OAuth

interface GithubProfile {
  id: number;
  login: string;
  avatar_url?: string;
}

function oauthConfig(env: Env): { clientId: string; clientSecret: string } | null {
  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  if (
    typeof clientId !== "string" ||
    typeof clientSecret !== "string" ||
    clientId.length === 0 ||
    clientSecret.length === 0 ||
    clientId.startsWith("<")
  ) {
    return null;
  }
  return { clientId, clientSecret };
}

// ----------------------------------------------------------- routes

/**
 * Handle `/api/auth/*`. Returns null for anything else so the caller can
 * fall through to the workspace router.
 */
export async function handleAuth(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/auth/")) return null;
  const sub = url.pathname.slice("/api/auth/".length);
  const mode = authMode(env);

  if (sub === "me" && request.method === "GET") {
    const { actor } = await resolveActor(request, env);
    return json({ mode, user: actor });
  }

  if (sub === "login" && request.method === "GET") {
    const oauth = oauthConfig(env);
    if (mode === "github" && oauth === null) {
      return apiError(503, "auth_not_configured", "Set GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET");
    }
    if (mode === "github" && oauth !== null) {
      const next = url.searchParams.get("next") ?? "/";
      const redirectUri = `${url.origin}/api/auth/callback`;
      const authorize = new URL("https://github.com/login/oauth/authorize");
      authorize.searchParams.set("client_id", oauth.clientId);
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set("scope", "read:user");
      authorize.searchParams.set("state", next.startsWith("/") ? next : "/");
      return new Response(null, { status: 302, headers: { location: authorize.toString() } });
    }
    return json({ mode, message: "Dev mode: identity is local (POST /api/auth/dev to switch)" });
  }

  if (sub === "callback" && request.method === "GET") {
    const oauth = oauthConfig(env);
    if (mode !== "github" || oauth === null) {
      return apiError(400, "auth_not_configured", "OAuth is not configured on this deployment");
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? "/";
    if (code === null) return apiError(400, "invalid_request", "Missing OAuth code");

    try {
      const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          client_id: oauth.clientId,
          client_secret: oauth.clientSecret,
          code,
        }),
      });
      const tokenBody = (await tokenResponse.json()) as { access_token?: string };
      if (tokenBody.access_token === undefined) {
        return apiError(502, "oauth_failed", "GitHub did not return an access token");
      }
      const profileResponse = await fetch("https://api.github.com/user", {
        headers: {
          authorization: `Bearer ${tokenBody.access_token}`,
          accept: "application/vnd.github+json",
          "user-agent": "latch",
        },
      });
      const profile = (await profileResponse.json()) as GithubProfile;
      if (typeof profile.login !== "string" || typeof profile.id !== "number") {
        return apiError(502, "oauth_failed", "GitHub did not return a profile");
      }
      const actor: Actor = {
        id: `gh:${profile.id}`,
        login: profile.login,
        ...(profile.avatar_url !== undefined ? { avatarUrl: profile.avatar_url } : {}),
      };
      const cookie = cookieHeader(
        `${SESSION_COOKIE}=${encodeURIComponent(await signSession(actor, sessionSecret(env)))}`,
        url.origin,
        SESSION_TTL_SECONDS,
      );
      const safeNext = state.startsWith("/") && !state.startsWith("//") ? state : "/";
      return new Response(null, {
        status: 302,
        headers: { location: safeNext, "set-cookie": cookie },
      });
    } catch (error) {
      return apiError(502, "oauth_failed", (error as Error).message);
    }
  }

  if (sub === "logout" && request.method === "POST") {
    const cleared = cookieHeader(`${SESSION_COOKIE}=`, url.origin, 0);
    return new Response(null, { status: 204, headers: { "set-cookie": cleared } });
  }

  if (sub === "dev" && request.method === "POST") {
    if (mode !== "dev") {
      return apiError(403, "dev_auth_disabled", "Identity switching is only available in dev mode");
    }
    const body = await readBody(request);
    const login = requireString(body, "login");
    const actor: Actor = { id: `dev:${login}`, login };
    const cookie = cookieHeader(
      `${SESSION_COOKIE}=${encodeURIComponent(await signSession(actor, sessionSecret(env)))}`,
      url.origin,
      SESSION_TTL_SECONDS,
    );
    return new Response(JSON.stringify({ mode, user: actor }), {
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": cookie },
    });
  }

  return apiError(404, "not_found", `Unknown auth route ${request.method} /api/auth/${sub}`);
}
