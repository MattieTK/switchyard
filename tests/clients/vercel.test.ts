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

  it("reads encrypted values from the per-variable endpoint, not the list", async () => {
    const f = fakeFetch([
      json({
        envs: [
          { id: "e1", key: "SECRET", value: "c2lwaGVydGV4dA==", decrypted: false, type: "encrypted", target: ["production"] },
          { id: "e2", key: "PUBLIC", value: "https://x", type: "plain", target: ["production"] },
          { id: "e3", key: "TOKEN", type: "sensitive", target: ["production"] },
          { id: "e4", key: "VERCEL_URL", type: "system", target: ["production"] },
        ],
      }),
      json({ id: "e1", key: "SECRET", value: "plaintext", decrypted: true, type: "encrypted", target: ["production"] }),
    ]);
    const envs = await createVercelClient({ fetch: f.fetch, token: "t", teamId: "team_1" }).listEnv("p 1");
    expect(f.calls.map((c) => c.url)).toEqual([
      "https://api.vercel.com/v10/projects/p%201/env?teamId=team_1",
      "https://api.vercel.com/v1/projects/p%201/env/e1?teamId=team_1",
    ]);
    expect(envs.map((e) => [e.id, e.value])).toEqual([
      ["e1", "plaintext"],
      ["e2", "https://x"],
      ["e3", undefined],
      ["e4", undefined],
    ]);
    expect(envs[0]?.decrypted).toBe(true);
  });

  it("leaves the value unset when the per-variable endpoint does not decrypt it", async () => {
    const f = fakeFetch([
      json({ envs: [{ id: "e1", key: "SECRET", value: "cipher", decrypted: false, type: "encrypted", target: ["production"] }] }),
      json({ id: "e1", key: "SECRET", value: "cipher", decrypted: false, type: "encrypted", target: ["production"] }),
    ]);
    const envs = await createVercelClient({ fetch: f.fetch, token: "t" }).listEnv("p1");
    expect(envs[0]?.value).toBeUndefined();
  });

  it("fetches at most five variables at a time", async () => {
    let active = 0;
    let peak = 0;
    const envs = Array.from({ length: 12 }, (_, i) => ({ id: `e${i}`, key: `K${i}`, type: "encrypted", target: ["production"] }));
    const detail = async (url: string) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      const eid = url.split("/env/")[1]?.split("?")[0];
      return json({ id: eid, key: "K", value: `v-${eid}`, decrypted: true, type: "encrypted", target: ["production"] });
    };
    const fetch = async (url: string) => (url.includes("/v10/") ? json({ envs }) : detail(url));
    const out = await createVercelClient({ fetch, token: "t" }).listEnv("p1");
    expect(out.map((e) => e.value)).toEqual(envs.map((e) => `v-${e.id}`));
    expect(peak).toBe(5);
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
