import { describe, expect, it } from "vitest";
import { createVercelClient, probeVercelToken } from "../../src/clients/vercel.ts";
import { isAuthError } from "../../src/http.ts";
import { fakeFetch, json } from "../helpers/fake-fetch.ts";

describe("createVercelClient", () => {
  it("pages through projects with `until` and adds teamId", async () => {
    const f = fakeFetch([
      json({ projects: [{ id: "p1", name: "a" }], pagination: { next: 1700 } }),
      json({ projects: [{ id: "p2", name: "b" }], pagination: { next: null } }),
    ]);
    const c = createVercelClient({ fetch: f.fetch, token: "t", teamId: "team_1" });
    expect((await c.listProjects()).map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(f.calls[0]?.url).toBe("https://api.vercel.com/v9/projects?teamId=team_1&limit=100");
    expect(f.calls[1]?.url).toBe("https://api.vercel.com/v9/projects?teamId=team_1&limit=100&until=1700");
  });

  it("requests decrypted env vars", async () => {
    const f = fakeFetch([json({ envs: [{ id: "e1", key: "A", value: "1", type: "plain", target: ["production"] }] })]);
    const envs = await createVercelClient({ fetch: f.fetch, token: "t" }).listEnv("p 1");
    expect(envs[0]?.key).toBe("A");
    expect(f.calls[0]?.url).toBe("https://api.vercel.com/v10/projects/p%201/env?decrypt=true");
  });

  it("lists domains and gets one project", async () => {
    const f = fakeFetch([json({ domains: [{ name: "example.com" }] }), json({ id: "p1", name: "a", framework: "nextjs" })]);
    const c = createVercelClient({ fetch: f.fetch, token: "t" });
    expect(await c.listDomains("p1")).toEqual([{ name: "example.com" }]);
    expect((await c.getProject("p1")).framework).toBe("nextjs");
  });

  it("treats invalidToken 403 as an auth error", async () => {
    const f = fakeFetch([json({ error: { code: "forbidden", message: "Not authorized", invalidToken: true } }, 403)]);
    const err = await createVercelClient({ fetch: f.fetch, token: "bad" }).getUser().catch((e: unknown) => e);
    expect(isAuthError(err)).toBe(true);
  });
});

describe("probeVercelToken", () => {
  it("records which calls succeed", async () => {
    const f = fakeFetch([
      json({ error: { message: "forbidden for this scope" } }, 403),
      json({ error: { message: "forbidden for this scope" } }, 403),
      json({ projects: [], pagination: { next: null } }),
    ]);
    const probe = await probeVercelToken(createVercelClient({ fetch: f.fetch, token: "t" }));
    expect(probe).toEqual({ userOk: false, user: null, teams: null, projectsOk: true });
  });

  it("returns user and teams for a full-account token", async () => {
    const f = fakeFetch([
      json({ user: { id: "u", username: "matt" } }),
      json({ teams: [{ id: "team_1", slug: "acme", name: "Acme" }] }),
      json({ projects: [], pagination: { next: null } }),
    ]);
    const probe = await probeVercelToken(createVercelClient({ fetch: f.fetch, token: "t" }));
    expect(probe.userOk).toBe(true);
    expect(probe.user?.username).toBe("matt");
    expect(probe.teams).toHaveLength(1);
  });

  it("rethrows auth errors so a rejected token is reported as such", async () => {
    const bad = json({ error: { invalidToken: true } }, 403);
    const f = fakeFetch([bad, bad.clone(), bad.clone()]);
    await expect(probeVercelToken(createVercelClient({ fetch: f.fetch, token: "t" }))).rejects.toThrow();
  });
});
