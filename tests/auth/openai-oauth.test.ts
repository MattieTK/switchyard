import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createChatGPTTokenProvider,
  jwtClaims,
  pollDeviceCode,
  refreshChatGPTTokens,
  requestDeviceCode,
  type ChatGPTTokens,
} from "../../src/auth/openai-oauth.ts";
import { createCredentialStore } from "../../src/auth/store.ts";
import { isAuthError } from "../../src/http.ts";
import { fakeFetch, json } from "../helpers/fake-fetch.ts";
import { makeTempDir } from "../helpers/tmp.ts";

// An unsigned JWT with the claims OpenAI puts in its tokens.
export function jwt(claims: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

const access = (exp: number) =>
  jwt({ exp, "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "plus" } });
const idToken = jwt({ email: "me@example.com" });

describe("ChatGPT sign-in", () => {
  it("asks for a device code with Codex's public client", async () => {
    const f = fakeFetch([json({ device_auth_id: "dev-1", user_code: "ABCD-1234", interval: "5" })]);
    expect(await requestDeviceCode(f.fetch)).toEqual({
      deviceAuthId: "dev-1",
      userCode: "ABCD-1234",
      verificationUrl: "https://auth.openai.com/codex/device",
      interval: 5,
    });
    expect(f.calls[0]?.url).toBe("https://auth.openai.com/api/accounts/deviceauth/usercode");
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
  });

  it("waits while the code hasn't been entered, then exchanges the authorization code", async () => {
    const code = { deviceAuthId: "dev-1", userCode: "ABCD-1234", verificationUrl: "", interval: 5 };
    const f = fakeFetch([
      json({ error: "pending" }, 403),
      json({ authorization_code: "auth-code", code_challenge: "ch", code_verifier: "ver" }),
      json({ access_token: access(2_000), refresh_token: "rt-1", id_token: idToken }),
    ]);
    expect(await pollDeviceCode(f.fetch, code)).toBeNull();
    expect(await pollDeviceCode(f.fetch, code)).toEqual({
      accessToken: access(2_000),
      refreshToken: "rt-1",
      expiresAt: 2_000_000,
      accountId: "acct-1",
      email: "me@example.com",
      plan: "plus",
    });
    expect(JSON.parse(String(f.calls[1]?.init?.body))).toEqual({ device_auth_id: "dev-1", user_code: "ABCD-1234" });
    expect(f.calls[2]?.url).toBe("https://auth.openai.com/oauth/token");
    expect(Object.fromEntries(new URLSearchParams(String(f.calls[2]?.init?.body)))).toEqual({
      grant_type: "authorization_code",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      code: "auth-code",
      code_verifier: "ver",
      redirect_uri: "https://auth.openai.com/deviceauth/callback",
    });
  });

  it("refreshes with JSON and keeps what the refresh doesn't return", async () => {
    const f = fakeFetch([json({ access_token: access(5_000), refresh_token: "rt-2" })]);
    const before: ChatGPTTokens = { accessToken: "old", refreshToken: "rt-1", expiresAt: 0, email: "me@example.com" };
    expect(await refreshChatGPTTokens(f.fetch, before)).toMatchObject({ refreshToken: "rt-2", expiresAt: 5_000_000, email: "me@example.com" });
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      grant_type: "refresh_token",
      refresh_token: "rt-1",
    });
  });

  it("asks to sign in again when the refresh token was already used", async () => {
    const f = fakeFetch([json({ error: { code: "refresh_token_reused", message: "Already used" } }, 401)]);
    const e = await refreshChatGPTTokens(f.fetch, { accessToken: "a", refreshToken: "r", expiresAt: 0 }).catch((x: unknown) => x);
    expect(isAuthError(e)).toBe(true);
    expect((e as Error).message).toContain("Sign in again");
  });

  it("reads a JWT's claims, and nothing from a malformed one", () => {
    expect(jwtClaims(jwt({ a: 1 }))).toEqual({ a: 1 });
    expect(jwtClaims("not-a-jwt")).toEqual({});
  });
});

describe("createChatGPTTokenProvider", () => {
  it("returns a fresh token, and refreshes one about to expire only once for concurrent callers", async () => {
    const store = createCredentialStore(join(await makeTempDir(), "c.json"));
    await store.update(() => ({
      openai: { kind: "chatgpt", model: "gpt-5.5", accessToken: "old", refreshToken: "rt-1", expiresAt: 1_000_000 + 60_000 },
    }));
    const f = fakeFetch([json({ access_token: access(9_000), refresh_token: "rt-2" })]);
    const tokens = createChatGPTTokenProvider({ store, fetch: f.fetch, now: () => 1_000_000 });
    const [a, b] = await Promise.all([tokens(), tokens()]);
    expect(a.accessToken).toBe(access(9_000));
    expect(b.accessToken).toBe(access(9_000));
    expect(f.calls).toHaveLength(1);
    expect((await store.read()).openai).toMatchObject({ kind: "chatgpt", model: "gpt-5.5", refreshToken: "rt-2", expiresAt: 9_000_000 });
    // Now fresh, so no further request.
    expect((await tokens()).accessToken).toBe(access(9_000));
  });

  it("refuses when OpenAI is connected with an API key instead", async () => {
    const store = createCredentialStore(join(await makeTempDir(), "c.json"));
    await store.update(() => ({ openai: { kind: "apikey", apiKey: "sk", model: "gpt-5.5" } }));
    const e = await createChatGPTTokenProvider({ store, fetch: fakeFetch([]).fetch })().catch((x: unknown) => x);
    expect(isAuthError(e)).toBe(true);
  });
});
