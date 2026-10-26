import { describe, expect, it } from "vitest";
import type { AgentDriver, AgentId, AgentStatus } from "../../src/agent/types.ts";
import { makeApp } from "./helpers.ts";

const fakeDriver = (status: AgentStatus): AgentDriver => ({
  id: status.id,
  status: async () => status,
  run: async () => {
    throw new Error("not used");
  },
});

const agents: Record<AgentId, AgentDriver> = {
  claude: fakeDriver({ id: "claude", installed: true, signedIn: true, detail: "Signed in with your Claude subscription (Max)" }),
  codex: fakeDriver({ id: "codex", installed: false, signedIn: false, detail: "Not installed" }),
};

describe("agent routes", () => {
  it("lists each agent's status, the saved preferences and model suggestions", async () => {
    const { req } = await makeApp({ agents, modelSuggestions: async () => ({ claude: ["opus"], codex: [] }) });
    const res = await req("/api/agents");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      agents: [
        { id: "claude", installed: true, signedIn: true, detail: "Signed in with your Claude subscription (Max)" },
        { id: "codex", installed: false, signedIn: false, detail: "Not installed" },
      ],
      preferences: { preferred: null, models: {} },
      suggestions: { claude: ["opus"], codex: [] },
    });
  });

  it("saves preferences and refuses an unknown agent or an odd model name", async () => {
    const { req } = await makeApp({ agents });
    const saved = await req("/api/agents/preferences", {
      method: "PUT",
      json: { preferred: "claude", models: { claude: "sonnet", codex: "" } },
    });
    expect(saved.status).toBe(200);
    expect(((await (await req("/api/agents")).json()) as { preferences: unknown }).preferences).toEqual({
      preferred: "claude",
      models: { claude: "sonnet", codex: "" },
    });
    const unknown = await req("/api/agents/preferences", { method: "PUT", json: { preferred: "gemini", models: {} } });
    expect(unknown.status).toBe(400);
    const spaced = await req("/api/agents/preferences", { method: "PUT", json: { preferred: null, models: { codex: "a b" } } });
    expect(spaced.status).toBe(400);
  });

  it("needs the launch token", async () => {
    const { app } = await makeApp({ agents });
    const res = await app.request("/api/agents", { headers: { host: "localhost:4417" } });
    expect(res.status).toBe(401);
  });
});
