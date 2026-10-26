import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { modelSuggestions } from "../../src/agent/models.ts";
import { createPreferencesStore, DEFAULT_AGENT_PREFERENCES, modelFor } from "../../src/agent/preferences.ts";
import { makeTempDir } from "../helpers/tmp.ts";

describe("preferences store", () => {
  it("starts with no preferred agent and default models", async () => {
    const store = createPreferencesStore(join(await makeTempDir(), "preferences.json"));
    expect(await store.read()).toEqual(DEFAULT_AGENT_PREFERENCES);
  });

  it("keeps what was saved, in a private file", async () => {
    const file = join(await makeTempDir(), "preferences.json");
    const store = createPreferencesStore(file);
    await store.write({ preferred: "codex", models: { claude: "opus", codex: "gpt-6-luna" } });
    expect(await store.read()).toEqual({ preferred: "codex", models: { claude: "opus", codex: "gpt-6-luna" } });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveProperty("agent.preferred", "codex");
  });

  it("falls back to the defaults when the file is broken", async () => {
    const file = join(await makeTempDir(), "preferences.json");
    await writeFile(file, "{not json");
    expect(await createPreferencesStore(file).read()).toEqual(DEFAULT_AGENT_PREFERENCES);
    await writeFile(file, JSON.stringify({ agent: { preferred: "gemini", models: {} } }));
    expect(await createPreferencesStore(file).read()).toEqual(DEFAULT_AGENT_PREFERENCES);
  });

  it("refuses model names a command line would misread", async () => {
    const store = createPreferencesStore(join(await makeTempDir(), "preferences.json"));
    await expect(store.write({ preferred: null, models: { claude: "opus --bare" } })).rejects.toThrow();
  });

  it("treats an empty model as the CLI default", () => {
    expect(modelFor({ preferred: "claude", models: { claude: "" } }, "claude")).toBeUndefined();
    expect(modelFor({ preferred: "claude", models: { codex: "gpt-6-luna" } }, "codex")).toBe("gpt-6-luna");
  });
});

describe("modelSuggestions", () => {
  it("suggests Claude's aliases and the Codex models its cache lists", async () => {
    const home = await makeTempDir();
    await mkdir(join(home, ".codex"));
    await writeFile(
      join(home, ".codex", "models_cache.json"),
      JSON.stringify({ models: [{ slug: "gpt-6-luna", visibility: "list" }, { slug: "codex-auto-review", visibility: "hide" }] }),
    );
    expect(await modelSuggestions({}, home)).toEqual({ claude: ["opus", "sonnet", "haiku"], codex: ["gpt-6-luna"] });
  });

  it("suggests no Codex models without a cache", async () => {
    expect((await modelSuggestions({}, await makeTempDir())).codex).toEqual([]);
  });
});
