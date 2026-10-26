import { relative } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import type { AgentDrivers } from "../agent/drivers.ts";
import type { PreferencesStore } from "../agent/preferences.ts";
import type { AgentId } from "../agent/types.ts";
import type { PendingAuthStore } from "../auth/cloudflare-oauth.ts";
import type { CredentialStore } from "../auth/store.ts";
import type { ClientFactory } from "../clients/factory.ts";
import { UserInputError } from "../errors.ts";
import { ApiError, type FetchFn } from "../http.ts";
import type { JobService } from "../pipeline/service.ts";
import { hostGuard, tokenGuard } from "./guard.ts";
import { agentRoutes } from "./routes/agents.ts";
import { connectRoutes } from "./routes/connect.ts";
import { jobRoutes } from "./routes/jobs.ts";

export interface AppDeps {
  port: number;
  launchToken: string;
  staticDir: string | null;
  store: CredentialStore;
  fetch: FetchFn;
  clients: ClientFactory;
  jobs: JobService;
  agents: AgentDrivers;
  preferences: PreferencesStore;
  modelSuggestions(): Promise<Record<AgentId, string[]>>;
  oauth: { clientId: string; redirectUri: string; scopes: readonly string[]; pending: PendingAuthStore };
}

export function createApp(d: AppDeps): Hono {
  const app = new Hono();
  app.use("*", hostGuard(d.port));
  app.use("/api/*", tokenGuard(d.launchToken));
  app.route("/", connectRoutes(d));
  app.route("/api", jobRoutes(d));
  app.route("/api", agentRoutes(d));

  if (d.staticDir) {
    const root = relative(process.cwd(), d.staticDir) || ".";
    app.use("/*", serveStatic({ root }));
    app.get("*", serveStatic({ root, path: "index.html" }));
  }

  app.onError((err, c) => {
    if (err instanceof UserInputError) return c.json({ error: err.message }, err.status);
    if (err instanceof ZodError) {
      return c.json({ error: `Invalid request: ${err.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` }, 400);
    }
    if (err instanceof ApiError) {
      return err.auth ? c.json({ error: err.message, reconnect: err.service }, 401) : c.json({ error: err.message }, 502);
    }
    if (err instanceof HTTPException) return err.getResponse();
    console.error(err);
    return c.json({ error: err.message }, 500);
  });
  return app;
}
