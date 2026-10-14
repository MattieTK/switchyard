import { join } from "node:path";
import { createPendingAuthStore } from "../../src/auth/cloudflare-oauth.ts";
import { createCredentialStore } from "../../src/auth/store.ts";
import type { ClientFactory } from "../../src/clients/factory.ts";
import type { JobService } from "../../src/pipeline/service.ts";
import { createApp, type AppDeps } from "../../src/server/app.ts";
import { fakeFetch } from "../helpers/fake-fetch.ts";
import { makeTempDir } from "../helpers/tmp.ts";

export const TOKEN = "launch-token-123";

export async function makeApp(over: Partial<AppDeps> = {}) {
  const dir = await makeTempDir();
  const store = createCredentialStore(join(dir, "credentials.json"));
  const deps: AppDeps = {
    port: 4417,
    launchToken: TOKEN,
    staticDir: null,
    store,
    fetch: fakeFetch([]).fetch,
    clients: {} as ClientFactory,
    jobs: {} as JobService,
    oauth: {
      clientId: "cid",
      redirectUri: "http://localhost:4417/auth/cloudflare/callback",
      scopes: ["user-details.read"],
      pending: createPendingAuthStore(),
    },
    ...over,
  };
  const app = createApp(deps);
  const req = (path: string, init: { method?: string; json?: unknown; headers?: Record<string, string> } = {}) =>
    app.request(path, {
      method: init.method ?? "GET",
      headers: {
        host: "localhost:4417",
        "x-switchyard-token": TOKEN,
        ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
  return { app, deps, store, req, dir };
}
