import { describe, expect, it } from "vitest";
import { createCloudflareClient } from "../../src/clients/cloudflare.ts";
import { fakeFetch, json } from "../helpers/fake-fetch.ts";

const ok = (result: unknown, result_info?: unknown) => json({ success: true, errors: [], result, result_info });
const BASE = "https://api.cloudflare.com/client/v4";

function client(responses: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(responses);
  return { c: createCloudflareClient({ fetch: f.fetch, token: async () => "oauth-tok" }), calls: f.calls };
}

describe("createCloudflareClient", () => {
  it("pages through accounts", async () => {
    const { c, calls } = client([
      ok([{ id: "a1", name: "One" }], { page: 1, total_pages: 2 }),
      ok([{ id: "a2", name: "Two" }], { page: 2, total_pages: 2 }),
    ]);
    expect((await c.listAccounts()).map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(calls[1]?.url).toBe(`${BASE}/accounts?page=2&per_page=50`);
  });

  it("filters zones by account", async () => {
    const { c, calls } = client([ok([{ id: "z1", name: "example.com" }], { page: 1, total_pages: 1 })]);
    await c.listZones("acc");
    expect(calls[0]?.url).toBe(`${BASE}/zones?account.id=acc&page=1&per_page=50`);
  });

  it("finds a Worker's tag by name, or null", async () => {
    const { c } = client([ok([{ id: "other", tag: "t0" }, { id: "my-app", tag: "t1" }]), ok([])]);
    expect(await c.getWorkerTag("acc", "my-app")).toBe("t1");
    expect(await c.getWorkerTag("acc", "my-app")).toBeNull();
  });

  it("creates a repo connection and returns its UUID", async () => {
    const { c, calls } = client([ok({ repo_connection_uuid: "rc-1" })]);
    const uuid = await c.putRepoConnection("acc", {
      provider_type: "github",
      provider_account_id: "1",
      provider_account_name: "me",
      repo_id: "2",
      repo_name: "app",
    });
    expect(uuid).toBe("rc-1");
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(calls[0]?.url).toBe(`${BASE}/accounts/acc/builds/repos/connections`);
  });

  it("creates triggers, sets env and starts builds", async () => {
    const { c, calls } = client([
      ok({ trigger_uuid: "tr-1", trigger_name: "switchyard-production" }),
      ok(null),
      ok({ build_uuid: "b-1" }),
      ok({ build_uuid: "b-1", status: "running", build_outcome: null }),
    ]);
    const trigger = await c.createTrigger("acc", {
      external_script_id: "tag",
      repo_connection_uuid: "rc",
      build_token_uuid: "bt",
      trigger_name: "switchyard-production",
      build_command: "pnpm exec cf build",
      deploy_command: "pnpm exec cf deploy --prebuilt",
      root_directory: "/",
      branch_includes: ["main"],
      branch_excludes: [],
      path_includes: ["*"],
      path_excludes: [],
      build_caching_enabled: true,
    });
    expect(trigger.trigger_uuid).toBe("tr-1");
    await c.setTriggerEnv("acc", "tr-1", { A: { value: "1", is_secret: false } });
    expect(calls[1]?.init?.method).toBe("PATCH");
    expect(calls[1]?.url).toBe(`${BASE}/accounts/acc/builds/triggers/tr-1/environment_variables`);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ A: { value: "1", is_secret: false } });
    expect(await c.startBuild("acc", "tr-1", "cloudflare-migration")).toBe("b-1");
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ branch: "cloudflare-migration" });
    expect((await c.getBuild("acc", "b-1")).status).toBe("running");
  });

  it("joins Cloudflare error messages into the ApiError", async () => {
    const { c } = client([json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 403)]);
    await expect(c.listBuildTokens("acc")).rejects.toThrow("Authentication error (10000)");
  });
});
