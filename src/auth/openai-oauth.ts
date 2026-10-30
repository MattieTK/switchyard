import { ApiError, type FetchFn } from "../http.ts";
import type { CredentialStore } from "./store.ts";

// Sign in with ChatGPT, as the Codex CLI and other local coding agents such as Hermes Agent do:
// a device code the user enters at OpenAI, then tokens for the user's ChatGPT plan. The client is
// Codex's public one (no secret), from codex-rs/login; OpenAI publishes no other for local apps.
export const OPENAI_ISSUER = "https://auth.openai.com";
export const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = `${OPENAI_ISSUER}/oauth/token`;
// The device code expires after this long, as Codex says when it shows one.
export const DEVICE_CODE_TTL_MS = 15 * 60_000;

export interface DeviceCode {
  deviceAuthId: string;
  userCode: string;
  // Where the user enters the code.
  verificationUrl: string;
  // Seconds between polls.
  interval: number;
}

export interface ChatGPTTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  // The ChatGPT account (personal or workspace) requests are made for.
  accountId?: string;
  email?: string;
  // Such as "plus" or "pro".
  plan?: string;
}

const errorText = async (res: Response) => {
  const text = await res.text().catch(() => "");
  try {
    const b = JSON.parse(text) as { error?: string | { message?: string; code?: string }; error_description?: string };
    if (typeof b.error_description === "string") return b.error_description;
    if (typeof b.error === "string") return b.error;
    return b.error?.message ?? b.error?.code ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
};

export async function requestDeviceCode(fetch: FetchFn): Promise<DeviceCode> {
  const res = await fetch(`${OPENAI_ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: OPENAI_CLIENT_ID }),
  });
  if (!res.ok) throw new ApiError("openai", res.status, `OpenAI didn't start the sign-in: ${await errorText(res)}`);
  const b = (await res.json()) as { device_auth_id: string; user_code?: string; usercode?: string; interval?: string | number };
  const interval = Number.parseInt(String(b.interval ?? "5"), 10);
  return {
    deviceAuthId: b.device_auth_id,
    userCode: b.user_code ?? b.usercode ?? "",
    verificationUrl: `${OPENAI_ISSUER}/codex/device`,
    interval: Number.isFinite(interval) && interval > 0 ? interval : 5,
  };
}

// Checks once whether the user has entered the code. Null while they haven't; then the tokens.
export async function pollDeviceCode(fetch: FetchFn, code: DeviceCode, now = Date.now()): Promise<ChatGPTTokens | null> {
  const res = await fetch(`${OPENAI_ISSUER}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ device_auth_id: code.deviceAuthId, user_code: code.userCode }),
  });
  // Codex treats both as "not entered yet".
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new ApiError("openai", res.status, `The ChatGPT sign-in failed: ${await errorText(res)}`);
  const b = (await res.json()) as { authorization_code: string; code_verifier: string };
  return tokenRequest(
    fetch,
    "form",
    {
      grant_type: "authorization_code",
      client_id: OPENAI_CLIENT_ID,
      code: b.authorization_code,
      code_verifier: b.code_verifier,
      redirect_uri: `${OPENAI_ISSUER}/deviceauth/callback`,
    },
    now,
  );
}

// Codex sends the code exchange as a form and refreshes as JSON.
async function tokenRequest(
  fetch: FetchFn,
  encoding: "form" | "json",
  params: Record<string, string>,
  now: number,
  previous?: ChatGPTTokens,
): Promise<ChatGPTTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": encoding === "form" ? "application/x-www-form-urlencoded" : "application/json",
      Accept: "application/json",
    },
    body: encoding === "form" ? new URLSearchParams(params).toString() : JSON.stringify(params),
  });
  if (!res.ok) {
    // A refresh token is used once, and an expired, reused or revoked one means signing in again.
    throw new ApiError("openai", res.status, `The ChatGPT sign-in has ended (${await errorText(res)}). Sign in again.`, res.status === 400 || res.status === 401);
  }
  const b = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number };
  const accessToken = b.access_token ?? previous?.accessToken;
  const refreshToken = b.refresh_token ?? previous?.refreshToken;
  if (!accessToken || !refreshToken) throw new ApiError("openai", 502, "OpenAI's sign-in returned no tokens.");
  const access = jwtClaims(accessToken);
  const id = b.id_token ? jwtClaims(b.id_token) : {};
  const auth = { ...authClaims(id), ...authClaims(access) };
  const exp = typeof access.exp === "number" ? access.exp * 1000 : now + (b.expires_in ?? 3600) * 1000;
  const email = typeof id.email === "string" ? id.email : previous?.email;
  const accountId = typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : previous?.accountId;
  const plan = typeof auth.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : previous?.plan;
  return {
    accessToken,
    refreshToken,
    expiresAt: exp,
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
  };
}

export function refreshChatGPTTokens(fetch: FetchFn, tokens: ChatGPTTokens, now = Date.now()): Promise<ChatGPTTokens> {
  return tokenRequest(
    fetch,
    "json",
    { client_id: OPENAI_CLIENT_ID, grant_type: "refresh_token", refresh_token: tokens.refreshToken },
    now,
    tokens,
  );
}

// A JWT's claims, unverified: OpenAI signs them, and Switchyard only reads which account they're for.
export function jwtClaims(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1] ?? "";
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const authClaims = (claims: Record<string, unknown>) => {
  const auth = claims["https://api.openai.com/auth"];
  return auth && typeof auth === "object" ? (auth as Record<string, unknown>) : {};
};

// A ChatGPT access token, refreshed when it's about to expire, as Codex does five minutes ahead.
// Refresh tokens are single-use, so only one refresh runs at a time and it re-reads the store first.
export function createChatGPTTokenProvider(o: {
  store: CredentialStore;
  fetch: FetchFn;
  now?: () => number;
}): () => Promise<ChatGPTTokens> {
  const now = o.now ?? Date.now;
  const WINDOW = 5 * 60_000;
  let refreshing: Promise<ChatGPTTokens> | null = null;
  const stored = async () => {
    const { openai } = await o.store.read();
    if (openai?.kind !== "chatgpt") throw new ApiError("openai", 401, "Not signed in with ChatGPT", true);
    return openai;
  };

  return async () => {
    if (refreshing) return refreshing;
    const current = await stored();
    if (current.expiresAt - now() > WINDOW) return current;
    refreshing ??= (async () => {
      try {
        const latest = await stored();
        if (latest.expiresAt - now() > WINDOW) return latest;
        const t = await refreshChatGPTTokens(o.fetch, latest, now());
        await o.store.update((c) => ({
          ...c,
          openai: c.openai?.kind === "chatgpt" ? { ...c.openai, ...t } : c.openai,
        }));
        return t;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  };
}
