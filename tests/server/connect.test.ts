import { describe, expect, it } from "vitest";
import type { ClientFactory } from "../../src/clients/factory.ts";
import { createOpenAIClient } from "../../src/clients/openai.ts";
import { ApiError } from "../../src/http.ts";
import { fakeFetch, json } from "../helpers/fake-fetch.ts";
import { makeApp, TOKEN } from "./helpers.ts";

const cfOk = (result: unknown) => json({ success: true, errors: [], result, result_info: { page: 1, total_pages: 1 } });

describe("Vercel token", () => {
  it("stores a team-scoped token and warns about an unusual prefix", async () => {
    const f = fakeFetch([
      json({ error: { message: "forbidden" } }, 403),
      json({ error: { message: "forbidden" } }, 403),
      json({ projects: [], pagination: { next: null } }),
    ]);
    const { req, store } = await makeApp({ fetch: f.fetch });
    const res = await req("/api/vercel/token", { method: "POST", json: { token: "  old-style-token  " } });
    const body = (await res.json()) as { scope: string; warning?: string };
    expect(res.status).toBe(200);
    expect(body.scope).toBe("team");
    expect(body.warning).toContain("vcp_");
    expect((await store.read()).vercel).toEqual({ token: "old-style-token", scope: "team" });
  });

  it("selects the only team automatically for an account-scoped token", async () => {
    const f = fakeFetch([
      json({ user: { id: "u", username: "matt" } }),
      json({ teams: [{ id: "team_1", slug: "acme", name: "Acme" }] }),
      json({ projects: [], pagination: { next: null } }),
    ]);
    const { req, store } = await makeApp({ fetch: f.fetch });
    const res = await req("/api/vercel/token", { method: "POST", json: { token: "vcp_team" } });
    expect(((await res.json()) as { scope: string }).scope).toBe("account");
    expect((await store.read()).vercel).toEqual({
      token: "vcp_team",
      scope: "account",
      username: "matt",
      teamId: "team_1",
      teamName: "Acme",
    });
  });

  it("leaves the team unset when an account token sees several teams", async () => {
    const f = fakeFetch([
      json({ user: { id: "u", username: "matt" } }),
      json({
        teams: [
          { id: "team_1", slug: "acme", name: "Acme" },
          { id: "team_2", slug: "beta", name: "Beta" },
        ],
      }),
      json({ projects: [], pagination: { next: null } }),
    ]);
    const { req, store } = await makeApp({ fetch: f.fetch });
    await req("/api/vercel/token", { method: "POST", json: { token: "vcp_acct" } });
    expect((await store.read()).vercel).toEqual({ token: "vcp_acct", scope: "account", username: "matt" });
  });

  it("rejects a token Vercel refuses, without storing it", async () => {
    const bad = json({ error: { invalidToken: true, message: "Not authorized" } }, 403);
    const { req, store } = await makeApp({ fetch: fakeFetch([bad, bad.clone(), bad.clone()]).fetch });
    const res = await req("/api/vercel/token", { method: "POST", json: { token: "vcp_bad" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("Vercel rejected this token");
    expect((await store.read()).vercel).toBeUndefined();
  });

  it("explains a project-scoped token", async () => {
    const forbidden = json({ error: { message: "forbidden" } }, 403);
    const { req } = await makeApp({ fetch: fakeFetch([forbidden, forbidden.clone(), forbidden.clone()]).fetch });
    const res = await req("/api/vercel/token", { method: "POST", json: { token: "vcp_project" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("All Projects");
  });

  it("only accepts teams the token can see", async () => {
    const vercel = { listTeams: async () => [{ id: "team_1", slug: "acme", name: "Acme" }] };
    const { req, store } = await makeApp({ clients: { vercel: async () => vercel } as unknown as ClientFactory });
    await store.update(() => ({ vercel: { token: "vcp_x", scope: "account" } }));
    expect((await req("/api/vercel/team", { method: "POST", json: { teamId: "team_2" } })).status).toBe(400);
    expect((await req("/api/vercel/team", { method: "POST", json: { teamId: "team_1" } })).status).toBe(200);
    expect((await store.read()).vercel).toMatchObject({ teamId: "team_1", teamName: "Acme" });
  });
});

describe("Cloudflare OAuth", () => {
  it("requires the launch token to start, then redirects with PKCE", async () => {
    const { req } = await makeApp();
    expect((await req("/auth/cloudflare/start", { headers: { "x-switchyard-token": "" } })).status).toBe(401);
    const res = await req(`/auth/cloudflare/start?t=${TOKEN}`, { headers: { "x-switchyard-token": "" } });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin).toBe("https://dash.cloudflare.com");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("state")).toBeTruthy();
  });

  it("rejects a callback with an unknown state without revealing the launch token", async () => {
    const { req } = await makeApp();
    const res = await req("/auth/cloudflare/callback?code=c&state=nope", { headers: { "x-switchyard-token": "" } });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("#/connect?error=");
    expect(location).not.toContain(TOKEN);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("does not reveal the launch token or reflect text when there is no valid state", async () => {
    const { req } = await makeApp();
    const res = await req("/auth/cloudflare/callback?error=x&error_description=evil", {
      headers: { "x-switchyard-token": "" },
    });
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("#/connect?error=");
    expect(location).not.toContain(TOKEN);
    expect(location).not.toContain("evil");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("exchanges the code, stores tokens and picks the only account", async () => {
    const f = fakeFetch([
      json({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
      cfOk({ id: "u", email: "me@example.com" }),
      cfOk([{ status: "accepted", account: { id: "acc1", name: "Main" }, permissions: { worker: { read: true, edit: true } } }]),
    ]);
    const { req, store, deps } = await makeApp({ fetch: f.fetch });
    const { state } = deps.oauth.pending.create();
    const res = await req(`/auth/cloudflare/callback?code=abc&state=${state}`, { headers: { "x-switchyard-token": "" } });
    expect(res.headers.get("location")).toBe(`/?t=${TOKEN}#/connect`);
    expect((await store.read()).cloudflare).toMatchObject({
      accessToken: "at",
      refreshToken: "rt",
      email: "me@example.com",
      accountId: "acc1",
      accountName: "Main",
    });
  });

  it("doesn't pick the only account when the user can't deploy Workers there", async () => {
    const f = fakeFetch([
      json({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
      cfOk({ id: "u", email: "me@example.com" }),
      cfOk([{ status: "accepted", account: { id: "acc1", name: "Main" }, permissions: { worker: { read: true, edit: false } } }]),
    ]);
    const { req, store, deps } = await makeApp({ fetch: f.fetch });
    const { state } = deps.oauth.pending.create();
    await req(`/auth/cloudflare/callback?code=abc&state=${state}`, { headers: { "x-switchyard-token": "" } });
    expect((await store.read()).cloudflare?.accountId).toBeUndefined();
  });

  it("refuses an account where the user can only read Workers", async () => {
    const clients = {
      cloudflare: { listAccounts: async () => [{ id: "ro", name: "Shared", canDeployWorkers: false }] },
    } as unknown as ClientFactory;
    const { req, store } = await makeApp({ clients });
    await store.update(() => ({ cloudflare: { accessToken: "x", expiresAt: 0 } }));
    const res = await req("/api/cloudflare/account", { method: "POST", json: { accountId: "ro" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "Your Cloudflare user can only read Workers on Shared, so Switchyard can't deploy there. Ask an administrator of that account for a role that can edit Workers, or choose another account.",
    );
    expect((await store.read()).cloudflare?.accountId).toBeUndefined();
  });

  it("reports an OAuth error returned by Cloudflare when the state is valid", async () => {
    const { req, deps } = await makeApp();
    const { state } = deps.oauth.pending.create();
    const res = await req(
      `/auth/cloudflare/callback?error=access_denied&error_description=User%20said%20no&state=${state}`,
      { headers: { "x-switchyard-token": "" } },
    );
    const location = res.headers.get("location") ?? "";
    expect(location).toContain(`t=${TOKEN}`);
    expect(decodeURIComponent(location)).toContain("User said no");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GitHub", () => {
  it("validates and stores a PAT", async () => {
    const f = fakeFetch([json({ login: "matt" })]);
    const { req, store } = await makeApp({ fetch: f.fetch });
    const res = await req("/api/github/pat", { method: "POST", json: { token: "github_pat_x" } });
    expect(await res.json()).toEqual({ ok: true, login: "matt" });
    expect((await store.read()).githubPat).toBe("github_pat_x");
  });
});

describe("status", () => {
  it("reports each service, treating auth failures as disconnected", async () => {
    const clients = {
      vercel: async () => ({ listTeams: async () => [] }),
      cloudflare: {
        listAccounts: async () => {
          throw new ApiError("cloudflare", 401, "expired", true);
        },
      },
      githubAuth: async () => ({ token: "gho", source: "gh" }),
      github: async () => ({ getViewer: async () => ({ login: "matt" }) }),
      openai: async () => null,
    } as unknown as ClientFactory;
    const { req, store } = await makeApp({ clients });
    await store.update(() => ({
      vercel: { token: "vcp", scope: "team", username: "matt" },
      cloudflare: { accessToken: "x", expiresAt: 0 },
    }));
    expect(await (await req("/api/status")).json()).toEqual({
      vercel: { connected: true, scope: "team", username: "matt", teams: [] },
      cloudflare: { connected: false, error: "cloudflare API error 401: expired" },
      github: { connected: true, source: "gh", login: "matt" },
      openai: { connected: false },
    });
  });
});

describe("OpenAI key", () => {
  const models = () => json({ data: [{ id: "gpt-4o" }, { id: "gpt-5.5" }, { id: "gpt-image-2" }, { id: "gpt-5.4-mini" }] });

  function withOpenAI(fetch: ReturnType<typeof fakeFetch>["fetch"]) {
    return {
      openaiWith: (apiKey: string) => createOpenAIClient({ fetch, apiKey }),
      openai: async () => ({ client: createOpenAIClient({ fetch, apiKey: "sk" }), model: "gpt-5.5" }),
    } as unknown as ClientFactory;
  }

  it("stores a working key with the best model it can use, and lets the user choose another", async () => {
    const f = fakeFetch([models(), models()]);
    const { req, store } = await makeApp({ clients: withOpenAI(f.fetch) });
    const res = await req("/api/openai/key", { method: "POST", json: { apiKey: " sk-proj-1 " } });
    expect(await res.json()).toEqual({ ok: true, model: "gpt-5.5" });
    expect((await store.read()).openai).toEqual({ kind: "apikey", apiKey: "sk-proj-1", model: "gpt-5.5" });

    expect((await req("/api/openai/model", { method: "POST", json: { model: "gpt-5.4-mini" } })).status).toBe(200);
    expect((await store.read()).openai?.model).toBe("gpt-5.4-mini");
  });

  it("refuses a rejected key and a model the key can't use", async () => {
    const f = fakeFetch([json({ error: { message: "Incorrect API key provided" } }, 401), models()]);
    const { req, store } = await makeApp({ clients: withOpenAI(f.fetch) });
    const bad = await req("/api/openai/key", { method: "POST", json: { apiKey: "sk-bad" } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("OpenAI rejected this key");

    await store.update((c) => ({ ...c, openai: { kind: "apikey", apiKey: "sk-1", model: "gpt-5.5" } }));
    const res = await req("/api/openai/model", { method: "POST", json: { model: "gpt-image-2" } });
    expect(res.status).toBe(400);
    expect((await store.read()).openai?.model).toBe("gpt-5.5");
  });

  it("disconnects", async () => {
    const { req, store } = await makeApp();
    await store.update(() => ({ openai: { kind: "apikey", apiKey: "sk-1", model: "gpt-5.5" } }));
    await req("/api/openai", { method: "DELETE" });
    expect((await store.read()).openai).toBeUndefined();
  });
});

describe("Sign in with ChatGPT", () => {
  const jwt = (claims: Record<string, unknown>) =>
    `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
  const accessToken = jwt({ exp: 4_000_000_000, "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "plus" } });

  it("shows a code, waits for it to be entered, then saves the sign-in with the plan's best model", async () => {
    const f = fakeFetch([
      json({ device_auth_id: "dev-1", user_code: "ABCD-1234", interval: "5" }),
      json({}, 403),
      json({ authorization_code: "code", code_challenge: "c", code_verifier: "v" }),
      json({ access_token: accessToken, refresh_token: "rt", id_token: jwt({ email: "me@example.com" }) }),
    ]);
    const clients = {
      chatgptWith: () => ({ listModels: async () => ["gpt-5.5", "gpt-5.4"] }),
    } as unknown as ClientFactory;
    const { req, store } = await makeApp({ fetch: f.fetch, clients });

    const start = await req("/api/openai/device", { method: "POST" });
    expect(await start.json()).toEqual({ userCode: "ABCD-1234", verificationUrl: "https://auth.openai.com/codex/device", interval: 5 });
    expect(await (await req("/api/openai/device/poll", { method: "POST" })).json()).toEqual({ status: "pending" });
    expect(await (await req("/api/openai/device/poll", { method: "POST" })).json()).toEqual({ status: "connected", model: "gpt-5.5" });
    expect((await store.read()).openai).toMatchObject({
      kind: "chatgpt",
      model: "gpt-5.5",
      refreshToken: "rt",
      accountId: "acct-1",
      email: "me@example.com",
      plan: "plus",
    });
    // The sign-in is finished, so there's nothing left to poll.
    expect((await req("/api/openai/device/poll", { method: "POST" })).status).toBe(409);
  });
});

describe("OpenAI status", () => {
  it("says whether OpenAI is connected from the saved credentials, without the key", async () => {
    const { req, store } = await makeApp();
    expect(await (await req("/api/openai")).json()).toEqual({ connected: false });
    await store.update(() => ({ openai: { kind: "apikey", apiKey: "sk-secret", model: "gpt-5.5" } }));
    expect(await (await req("/api/openai")).json()).toEqual({ connected: true, via: "apikey", model: "gpt-5.5" });
  });
});
