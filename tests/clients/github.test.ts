import { describe, expect, it } from "vitest";
import { createGitHubClient } from "../../src/clients/github.ts";
import { ApiError } from "../../src/http.ts";
import { fakeFetch, json } from "../helpers/fake-fetch.ts";

function client(responses: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(responses);
  return { c: createGitHubClient({ fetch: f.fetch, token: async () => "gho_x" }), calls: f.calls };
}

describe("createGitHubClient", () => {
  it("maps repo fields", async () => {
    const { c } = client([
      json({ id: 2, name: "app", owner: { id: 1, login: "acme" }, default_branch: "main", private: true }),
    ]);
    expect(await c.getRepo("acme", "app")).toEqual({
      id: 2,
      name: "app",
      ownerId: 1,
      ownerLogin: "acme",
      defaultBranch: "main",
      private: true,
    });
  });

  it("explains a 404 repo as a possible access or SSO problem", async () => {
    const { c } = client([json({ message: "Not Found" }, 404)]);
    const err = await c.getRepo("acme", "secret").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as Error).message).toContain("acme/secret");
    expect((err as Error).message).toContain("SSO");
  });

  it("decodes file contents and returns null for missing files and directories", async () => {
    const { c, calls } = client([
      json({ type: "file", encoding: "base64", content: Buffer.from('{"crons":[]}').toString("base64") }),
      json({ message: "Not Found" }, 404),
      json([{ name: "a" }]),
    ]);
    expect(await c.getFile("o", "r", "apps/web/vercel.json", "main")).toBe('{"crons":[]}');
    expect(calls[0]?.url).toBe("https://api.github.com/repos/o/r/contents/apps/web/vercel.json?ref=main");
    expect(await c.getFile("o", "r", "vercel.json", "main")).toBeNull();
    expect(await c.getFile("o", "r", "dir", "main")).toBeNull();
  });

  it("lists directory entries", async () => {
    const { c, calls } = client([json([{ name: "package.json" }, { name: "pnpm-lock.yaml" }])]);
    expect(await c.listDir("o", "r", "", "main")).toEqual(["package.json", "pnpm-lock.yaml"]);
    expect(calls[0]?.url).toBe("https://api.github.com/repos/o/r/contents/?ref=main");
  });

  it("finds an open PR from the migration branch, or creates one", async () => {
    const { c, calls } = client([
      json([]),
      json({ html_url: "https://github.com/o/r/pull/7", number: 7 }),
    ]);
    expect(await c.findOpenPr("o", "r", "cloudflare-migration")).toBeNull();
    expect(calls[0]?.url).toBe("https://api.github.com/repos/o/r/pulls?state=open&head=o%3Acloudflare-migration");
    const pr = await c.createPr("o", "r", { title: "t", head: "cloudflare-migration", base: "main", body: "b" });
    expect(pr).toEqual({ url: "https://github.com/o/r/pull/7", number: 7 });
  });
});
