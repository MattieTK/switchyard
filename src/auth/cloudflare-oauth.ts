import { ApiError, type FetchFn } from "../http.ts";
import { challengeFor, createPkcePair, randomToken } from "./pkce.ts";
import type { CredentialStore } from "./store.ts";

export const CF_AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
export const CF_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export function buildAuthorizeUrl(p: {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  challenge: string;
}): string {
  const url = new URL(CF_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: p.scopes.join(" "),
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

async function tokenRequest(fetch: FetchFn, params: Record<string, string>, now: number): Promise<TokenSet> {
  const res = await fetch(CF_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(await res.text()) as Record<string, unknown>;
  } catch {
    // Leave body empty; the status code is reported below.
  }
  if (!res.ok || typeof body.access_token !== "string") {
    const detail =
      typeof body.error_description === "string"
        ? body.error_description
        : typeof body.error === "string"
          ? body.error
          : `HTTP ${res.status}`;
    throw new ApiError("cloudflare", res.status, `OAuth token request failed: ${detail}`, res.status === 400 || res.status === 401);
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    expiresAt: now + expiresIn * 1000,
  };
}

export function exchangeCode(
  fetch: FetchFn,
  p: { clientId: string; redirectUri: string; code: string; verifier: string },
  now = Date.now(),
): Promise<TokenSet> {
  return tokenRequest(
    fetch,
    {
      grant_type: "authorization_code",
      code: p.code,
      redirect_uri: p.redirectUri,
      client_id: p.clientId,
      code_verifier: p.verifier,
    },
    now,
  );
}

export function refreshTokens(
  fetch: FetchFn,
  p: { clientId: string; refreshToken: string },
  now = Date.now(),
): Promise<TokenSet> {
  return tokenRequest(fetch, { grant_type: "refresh_token", refresh_token: p.refreshToken, client_id: p.clientId }, now);
}

export function createCloudflareTokenProvider(o: {
  store: CredentialStore;
  fetch: FetchFn;
  clientId: string;
  now?: () => number;
}): () => Promise<string> {
  const now = o.now ?? Date.now;
  let refreshing: Promise<string> | null = null;

  return async () => {
    const { cloudflare } = await o.store.read();
    if (!cloudflare) throw new ApiError("cloudflare", 401, "Cloudflare is not connected", true);
    if (cloudflare.expiresAt - now() > 60_000) return cloudflare.accessToken;
    const refreshToken = cloudflare.refreshToken;
    if (!refreshToken) throw new ApiError("cloudflare", 401, "The Cloudflare session has expired", true);

    refreshing ??= (async () => {
      try {
        const t = await refreshTokens(o.fetch, { clientId: o.clientId, refreshToken }, now());
        await o.store.update((c) => ({
          ...c,
          cloudflare: {
            ...(c.cloudflare ?? cloudflare),
            accessToken: t.accessToken,
            expiresAt: t.expiresAt,
            refreshToken: t.refreshToken ?? refreshToken,
          },
        }));
        return t.accessToken;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  };
}

export interface PendingAuthStore {
  create(): { state: string; challenge: string };
  take(state: string): string | null;
}

export function createPendingAuthStore(ttlMs = 10 * 60_000, now: () => number = Date.now): PendingAuthStore {
  const pending = new Map<string, { verifier: string; createdAt: number }>();
  return {
    create() {
      const state = randomToken();
      const { verifier } = createPkcePair();
      pending.set(state, { verifier, createdAt: now() });
      return { state, challenge: challengeFor(verifier) };
    },
    take(state) {
      const entry = pending.get(state);
      pending.delete(state);
      if (!entry || now() - entry.createdAt > ttlMs) return null;
      return entry.verifier;
    },
  };
}
