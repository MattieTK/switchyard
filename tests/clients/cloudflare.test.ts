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
  it("lists accepted account memberships, with whether the user can deploy Workers", async () => {
    const member = (id: string, edit: boolean, status = "accepted") => ({
      status,
      account: { id, name: id.toUpperCase() },
      permissions: { worker: { read: true, edit } },
    });
    const { c, calls } = client([
      ok([member("a1", true), member("a2", false)], { page: 1, total_pages: 2 }),
      ok([member("a3", true, "pending"), { status: "accepted", account: { id: "a4", name: "A4" } }], { page: 2, total_pages: 2 }),
    ]);
    expect(await c.listAccounts()).toEqual([
      { id: "a1", name: "A1", canDeployWorkers: true },
      { id: "a2", name: "A2", canDeployWorkers: false },
      // Without permission details, Switchyard doesn't assume the worst.
      { id: "a4", name: "A4", canDeployWorkers: true },
    ]);
    expect(calls[1]?.url).toBe(`${BASE}/memberships?page=2&per_page=50`);
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

  it("creates an account API token and registers it as a build token, and can delete the API token", async () => {
    const { c, calls } = client([
      ok([{ id: "pg-1", name: "Workers Scripts Write", scopes: ["com.cloudflare.api.account"] }]),
      ok({ id: "tok-1", value: "secret-value", name: "Switchyard" }),
      ok({ build_token_uuid: "bt-9", build_token_name: "Switchyard" }),
      ok({ id: "tok-1" }),
    ]);
    expect(await c.listTokenPermissionGroups("acc")).toEqual([
      { id: "pg-1", name: "Workers Scripts Write", scopes: ["com.cloudflare.api.account"] },
    ]);
    expect(calls[0]?.url).toBe(`${BASE}/accounts/acc/tokens/permission_groups`);

    const policies = [{ effect: "allow" as const, permission_groups: [{ id: "pg-1" }], resources: { "com.cloudflare.api.account.acc": "*" } }];
    expect(await c.createAccountToken("acc", { name: "Switchyard", policies })).toEqual({ id: "tok-1", value: "secret-value" });
    expect(calls[1]?.init?.method).toBe("POST");
    expect(calls[1]?.url).toBe(`${BASE}/accounts/acc/tokens`);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ name: "Switchyard", policies });

    const token = await c.createBuildToken("acc", { build_token_name: "Switchyard", build_token_secret: "secret-value", cloudflare_token_id: "tok-1" });
    expect(token.build_token_uuid).toBe("bt-9");
    expect(calls[2]?.url).toBe(`${BASE}/accounts/acc/builds/tokens`);
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
      build_token_name: "Switchyard",
      build_token_secret: "secret-value",
      cloudflare_token_id: "tok-1",
    });

    await c.deleteAccountToken("acc", "tok-1");
    expect(calls[3]?.init?.method).toBe("DELETE");
    expect(calls[3]?.url).toBe(`${BASE}/accounts/acc/tokens/tok-1`);
  });

  it("joins Cloudflare error messages into the ApiError", async () => {
    const { c } = client([json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 403)]);
    await expect(c.listBuildTokens("acc")).rejects.toThrow("Authentication error (10000)");
  });
});
