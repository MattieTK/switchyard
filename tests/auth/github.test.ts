import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitAuthEnv, resolveGitHubAuth } from "../../src/auth/github.ts";
import { createCredentialStore } from "../../src/auth/store.ts";
import { fakeRunner } from "../helpers/fake-runner.ts";
import { makeTempDir } from "../helpers/tmp.ts";

async function store(pat?: string) {
  const s = createCredentialStore(join(await makeTempDir(), "c.json"));
  if (pat) await s.update((c) => ({ ...c, githubPat: pat }));
  return s;
}

describe("resolveGitHubAuth", () => {
  it("prefers the gh login", async () => {
    const { run, calls } = fakeRunner(() => ({ code: 0, output: "gho_abc\n" }));
    expect(await resolveGitHubAuth(run, await store("ghp_pat"))).toEqual({ token: "gho_abc", source: "gh" });
    expect(calls[0]).toMatchObject({ cmd: "gh", args: ["auth", "token"] });
  });

  it("reads the token from stdout when gh also writes to stderr", async () => {
    const { run } = fakeRunner(() => ({
      code: 0,
      output: "A new release of gh is available: 2.0.0\ngho_abc\n",
      stdout: "gho_abc\n",
    }));
    expect(await resolveGitHubAuth(run, await store("ghp_pat"))).toEqual({ token: "gho_abc", source: "gh" });
  });

  it("falls back to the stored PAT when gh is logged out", async () => {
    const { run } = fakeRunner(() => ({ code: 1, output: "not logged in" }));
    expect(await resolveGitHubAuth(run, await store("ghp_pat"))).toEqual({ token: "ghp_pat", source: "pat" });
  });

  it("falls back to the stored PAT when gh is not installed", async () => {
    const run = async () => {
      throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    };
    expect(await resolveGitHubAuth(run, await store("ghp_pat"))).toEqual({ token: "ghp_pat", source: "pat" });
  });

  it("returns null when neither is available", async () => {
    const { run } = fakeRunner(() => ({ code: 1, output: "" }));
    expect(await resolveGitHubAuth(run, await store())).toBeNull();
  });
});

describe("gitAuthEnv", () => {
  it("passes the token as an HTTP header through env-only git config", () => {
    const env = gitAuthEnv("tok");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${Buffer.from("x-access-token:tok").toString("base64")}`);
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });
});
