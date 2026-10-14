import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JobService } from "../../src/pipeline/service.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { makeApp, TOKEN } from "./helpers.ts";

const jobs = { list: async () => [] } as unknown as JobService;

describe("guards", () => {
  it("rejects unexpected Host headers (DNS rebinding)", async () => {
    const { req } = await makeApp({ jobs });
    const res = await req("/api/jobs", { headers: { host: "evil.example:4417" } });
    expect(res.status).toBe(403);
  });

  it("rejects API calls without the launch token", async () => {
    const { req } = await makeApp({ jobs });
    expect((await req("/api/jobs", { headers: { "x-switchyard-token": "" } })).status).toBe(401);
    expect((await req("/api/jobs", { headers: { "x-switchyard-token": "wrong-token-xyz" } })).status).toBe(401);
  });

  it("accepts the token as a header or a t query parameter, and 127.0.0.1 as host", async () => {
    const { req } = await makeApp({ jobs });
    expect((await req("/api/jobs")).status).toBe(200);
    expect(
      (await req(`/api/jobs?t=${TOKEN}`, { headers: { "x-switchyard-token": "", host: "127.0.0.1:4417" } })).status,
    ).toBe(200);
  });
});

describe("static files", () => {
  it("serves the SPA without a token, and falls back to index.html", async () => {
    const staticDir = await makeTempDir();
    await mkdir(join(staticDir, "assets"), { recursive: true });
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Switchyard</title>");
    await writeFile(join(staticDir, "assets", "app.js"), "console.log(1)");
    const { req } = await makeApp({ jobs, staticDir });
    const headers = { "x-switchyard-token": "" };
    expect(await (await req("/", { headers })).text()).toContain("<title>Switchyard</title>");
    expect(await (await req("/assets/app.js", { headers })).text()).toBe("console.log(1)");
    expect(await (await req("/projects", { headers })).text()).toContain("<title>Switchyard</title>");
  });
});
