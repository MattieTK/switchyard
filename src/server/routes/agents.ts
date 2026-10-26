import { Hono } from "hono";
import { agentPreferencesSchema } from "../../agent/preferences.ts";
import { AGENT_IDS } from "../../agent/types.ts";
import type { AppDeps } from "../app.ts";

export function agentRoutes(d: AppDeps): Hono {
  const r = new Hono();

  // Each check runs the CLI's own status command, which reads its stored sign-in only.
  r.get("/agents", async (c) => {
    const [agents, preferences, suggestions] = await Promise.all([
      Promise.all(AGENT_IDS.map((id) => d.agents[id].status())),
      d.preferences.read(),
      d.modelSuggestions(),
    ]);
    return c.json({ agents, preferences, suggestions });
  });

  r.put("/agents/preferences", async (c) =>
    c.json(await d.preferences.write(agentPreferencesSchema.parse(await c.req.json()))),
  );

  return r;
}
