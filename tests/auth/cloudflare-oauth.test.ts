import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  createCloudflareTokenProvider,
  createPendingAuthStore,
  exchangeCode,
} from "../../src/auth/cloudflare-oauth.ts";
import { type CredentialStore, createCredentialStore } from "../../src/auth/store.ts";
import { type FetchFn, isAuthError } from "../../src/http.ts";
import { fakeFetch, json } from "../helpers/fake-fetch.ts";
import { makeTempDir } from "../helpers/tmp.ts";

describe("buildAuthorizeUrl", () => {
  it("includes PKCE S256, state and space-separated scopes", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "cid",
        redirectUri: "http://localhost:4417/auth/cloudflare/callback",
        scopes: ["user-details.read", "workers-scripts.write"],
        state: "st",
        challenge: "ch",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "cid",
      redirect_uri: "http://localhost:4417/auth/cloudflare/callback",
      scope: "user-details.read workers-scripts.write",
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
    });
  });
});

describe("exchangeCode", () => {
  it("posts a form body and returns a token set with an absolute expiry", async () => {
    const f = fakeFetch([json({ access_token: "at", refresh_token: "rt", expires_in: 3600 })]);
    const t = await exchangeCode(f.fetch, { clientId: "cid", redirectUri: "r", code: "c", verifier: "v" }, 1_000);
    expect(t).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: 1_000 + 3_600_000 });
    expect(f.calls[0]?.url).toBe("https://dash.cloudflare.com/oauth2/token");
    expect(String(f.calls[0]?.init?.body)).toBe(
      "grant_type=authorization_code&code=c&redirect_uri=r&client_id=cid&code_verifier=v",
    );
  });

  it("surfaces the OAuth error description", async () => {
    const f = fakeFetch([json({ error: "invalid_grant", error_description: "Code expired" }, 400)]);
    await expect(
      exchangeCode(f.fetch, { clientId: "c", redirectUri: "r", code: "c", verifier: "v" }),
    ).rejects.toThrow("Code expired");
  });
});

describe("createCloudflareTokenProvider", () => {
  async function setup(expiresAt: number, responses: Parameters<typeof fakeFetch>[0] = []) {
    const dir = await makeTempDir();
    const store = createCredentialStore(join(dir, "credentials.json"));
    await store.update(() => ({ cloudflare: { accessToken: "old", refreshToken: "r1", expiresAt } }));
    const f = fakeFetch(responses);
    const provider = createCloudflareTokenProvider({ store, fetch: f.fetch, clientId: "cid", now: () => 10_000 });
    return { store, provider, calls: f.calls };
  }

  it("returns the stored token while it has more than a minute left", async () => {
    const { provider, calls } = await setup(10_000 + 120_000);
    expect(await provider()).toBe("old");
    expect(calls).toHaveLength(0);
  });

  it("refreshes near expiry, persists the new tokens, and refreshes once for concurrent callers", async () => {
    const { provider, store, calls } = await setup(10_000 + 30_000, [
      json({ access_token: "new", refresh_token: "r2", expires_in: 3600 }),
    ]);
    const [a, b] = await Promise.all([provider(), provider()]);
    expect([a, b]).toEqual(["new", "new"]);
    expect(calls).toHaveLength(1);
    expect((await store.read()).cloudflare).toMatchObject({ accessToken: "new", refreshToken: "r2" });
  });

  it("keeps the old refresh token if the response omits one", async () => {
    const { provider, store } = await setup(0, [json({ access_token: "new", expires_in: 3600 })]);
    await provider();
    expect((await store.read()).cloudflare?.refreshToken).toBe("r1");
  });

  it("does not send a second refresh when a stale read races a completed refresh", async () => {
    const dir = await makeTempDir();
    const real = createCredentialStore(join(dir, "credentials.json"));
    await real.update(() => ({ cloudflare: { accessToken: "old", refreshToken: "r1", expiresAt: 40_000 } }));
    const stale = await real.read();
    let staleReads = 0;
    const store: CredentialStore = {
      read: async () => {
        if (staleReads > 0) {
          staleReads -= 1;
          return stale;
        }
        return real.read();
      },
      update: real.update,
    };
    const f = fakeFetch([json({ access_token: "new", refresh_token: "r2", expires_in: 3600 })]);
    const provider = createCloudflareTokenProvider({ store, fetch: f.fetch, clientId: "cid", now: () => 10_000 });

    expect(await provider()).toBe("new");
    staleReads = 1;
    expect(await provider()).toBe("new");
    expect(f.calls).toHaveLength(1);
  });

  it("joins a refresh that is already in flight", async () => {
    const dir = await makeTempDir();
    const store = createCredentialStore(join(dir, "credentials.json"));
    await store.update(() => ({ cloudflare: { accessToken: "old", refreshToken: "r1", expiresAt: 40_000 } }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markSent!: () => void;
    const sent = new Promise<void>((resolve) => {
      markSent = resolve;
    });
    let tokenRequests = 0;
    const fetch: FetchFn = async () => {
      tokenRequests += 1;
      markSent();
      await gate;
      return json({ access_token: "new", refresh_token: "r2", expires_in: 3600 });
    };
    const provider = createCloudflareTokenProvider({ store, fetch, clientId: "cid", now: () => 10_000 });

    const first = provider();
    await sent;
    const second = provider();
    release();
    expect(await Promise.all([first, second])).toEqual(["new", "new"]);
    expect(tokenRequests).toBe(1);
  });

  it("throws an auth error when Cloudflare is not connected", async () => {
    const dir = await makeTempDir();
    const provider = createCloudflareTokenProvider({
      store: createCredentialStore(join(dir, "c.json")),
      fetch: fakeFetch([]).fetch,
      clientId: "cid",
    });
    expect(isAuthError(await provider().catch((e: unknown) => e))).toBe(true);
  });
});

describe("createPendingAuthStore", () => {
  it("returns the verifier once per state", () => {
    const pending = createPendingAuthStore();
    const { state } = pending.create();
    expect(pending.take(state)).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(pending.take(state)).toBeNull();
  });

  it("expires old flows", () => {
    let now = 0;
    const pending = createPendingAuthStore(1000, () => now);
    const { state } = pending.create();
    now = 1001;
    expect(pending.take(state)).toBeNull();
  });

  it("returns null for unknown states", () => {
    expect(createPendingAuthStore().take("nope")).toBeNull();
  });
});
