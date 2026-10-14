import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/auth/store.ts";
import { makeTempDir } from "../helpers/tmp.ts";

describe("createCredentialStore", () => {
  it("returns an empty object when the file does not exist", async () => {
    const dir = await makeTempDir();
    expect(await createCredentialStore(join(dir, "c", "credentials.json")).read()).toEqual({});
  });

  it("writes with mode 0600 inside a 0700 directory", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "c", "credentials.json");
    await createCredentialStore(file).update((c) => ({ ...c, githubPat: "ghp_x" }));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "c"))).mode & 0o777).toBe(0o700);
  });

  it("round-trips updates", async () => {
    const dir = await makeTempDir();
    const store = createCredentialStore(join(dir, "credentials.json"));
    await store.update((c) => ({ ...c, vercel: { token: "vcp_1", scope: "team" } }));
    expect(await store.read()).toEqual({ vercel: { token: "vcp_1", scope: "team" } });
  });

  it("applies concurrent updates one after another without losing either", async () => {
    const dir = await makeTempDir();
    const store = createCredentialStore(join(dir, "credentials.json"));
    await Promise.all([
      store.update((c) => ({ ...c, githubPat: "a" })),
      store.update((c) => ({ ...c, vercel: { token: "v", scope: "account" } })),
    ]);
    expect(await store.read()).toEqual({ githubPat: "a", vercel: { token: "v", scope: "account" } });
  });

  it("reports a corrupt file with its path", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "credentials.json");
    await writeFile(file, "{not json");
    await expect(createCredentialStore(file).read()).rejects.toThrow(file);
  });
});
