import { describe, expect, it } from "vitest";
import type { ClientFactory } from "../../src/clients/factory.ts";
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
      cfOk([{ id: "acc1", name: "Main" }]),
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
    });
  });
});
