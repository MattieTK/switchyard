import { Hono } from "hono";
import { type AgentPreferences, agentPreferencesSchema } from "../../agent/preferences.ts";
import { AGENT_IDS, type AgentId, type AgentStatus } from "../../agent/types.ts";
import type { AppDeps } from "../app.ts";

export interface AgentsResponse {
  agents: AgentStatus[];
  preferences: AgentPreferences;
  suggestions: Record<AgentId, string[]>;
}

export function agentRoutes(d: AppDeps): Hono {
  const r = new Hono();

  // Each check runs the CLI's own status command, which reads its stored sign-in only.
  r.get("/agents", async (c) => {
    const [agents, preferences, suggestions] = await Promise.all([
      Promise.all(AGENT_IDS.map((id) => d.agents[id].status())),
      d.preferences.read(),
      d.modelSuggestions(),
    ]);
    return c.json({ agents, preferences, suggestions } satisfies AgentsResponse);
  });

  r.put("/agents/preferences", async (c) =>
    c.json(await d.preferences.write(agentPreferencesSchema.parse(await c.req.json()))),
  );

  return r;
}
