import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import open from "open";
import { adapterById } from "../adapters/registry.ts";
import { createAgentDrivers } from "../agent/drivers.ts";
import { modelSuggestions } from "../agent/models.ts";
import { createPreferencesStore } from "../agent/preferences.ts";
import { createCloudflareTokenProvider, createPendingAuthStore } from "../auth/cloudflare-oauth.ts";
import { randomToken } from "../auth/pkce.ts";
import { createCredentialStore } from "../auth/store.ts";
import { createClientFactory } from "../clients/factory.ts";
import { CLOUDFLARE_CLIENT_ID, CLOUDFLARE_REDIRECT_URI, CLOUDFLARE_SCOPES, ORIGIN, PORT } from "../config.ts";
import { createCommandRunner, stopProcessGroups } from "../exec.ts";
import { resolvePaths } from "../paths.ts";
import { createJobEvents } from "../pipeline/events.ts";
import { createJobStore } from "../pipeline/job-store.ts";
import { createJobQueue } from "../pipeline/queue.ts";
import { createRecovery, discardInterruptedAgentWork, heldDevVarsPath } from "../pipeline/recovery.ts";
import { runJob } from "../pipeline/runner.ts";
import { createJobService } from "../pipeline/service.ts";
import { STEPS } from "../pipeline/steps/index.ts";
import type { PipelineDeps } from "../pipeline/types.ts";
import { createRedactor } from "../redact.ts";
import { ensurePackageManager } from "../toolchain.ts";
import { createApp } from "./app.ts";
import { describeListenError } from "./listen-error.ts";

const paths = resolvePaths();
const store = createCredentialStore(paths.credentialsFile);
const run = createCommandRunner({ pathPrefix: paths.binDir });
const redactor = createRedactor();
const cloudflareToken = createCloudflareTokenProvider({ store, fetch, clientId: CLOUDFLARE_CLIENT_ID });
const clients = createClientFactory({ store, fetch, run, cloudflareToken });
const jobStore = createJobStore(paths.jobsDir);
const events = createJobEvents();
const agents = createAgentDrivers(run);
const preferences = createPreferencesStore(paths.preferencesFile);

const pipeline: PipelineDeps = {
  run,
  cloudflare: clients.cloudflare,
  github: clients.github,
  githubToken: async () => (await clients.githubAuth()).token,
  cloudflareToken,
  adapter: adapterById,
  ensurePackageManager: (pm, cwd, log) => ensurePackageManager({ pm, cwd, run, binDir: paths.binDir, log }),
  workDir: paths.workDir,
  saveScreenshot: (jobId, image) => jobStore.writeScreenshot(jobId, image),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};
const recover = createRecovery({ agents, store: jobStore, redactor, pipeline, configDir: paths.configDir });
const queue = createJobQueue(
  (id) => runJob(id, STEPS, { store: jobStore, events, redactor, pipeline, recover }),
  (id, e) => console.error(`Job ${id} stopped unexpectedly:`, redactor.redact(String(e))),
);
const jobs = createJobService({ store: jobStore, events, queue, clients, credentials: store, agents, preferences });

const { failed, queued } = await jobStore.recoverInterrupted();
if (failed.length) console.log(`${failed.length} job(s) were interrupted last time and can be retried.`);
// A held .dev.vars means an agent was working when Switchyard stopped. Its working copy has
// unfinished edits, so the job converts again; convert writes .dev.vars again too.
for (const id of failed) {
  const held = heldDevVarsPath(paths.configDir, id);
  const job = existsSync(held) ? await jobStore.get(id) : null;
  if (!job) continue;
  await jobStore.save(discardInterruptedAgentWork(job));
  await rm(held, { force: true });
  console.log(`Job ${id} stopped while an agent was working, so its retry converts the project again.`);
}
for (const id of queued) queue.enqueue(id);

const staticDir = join(import.meta.dirname, "..", "..", "dist", "web");
if (!existsSync(join(staticDir, "index.html"))) {
  console.warn("The web UI hasn't been built yet. Start Switchyard with `pnpm start`, which builds it.");
}

const launchToken = randomToken();
const app = createApp({
  port: PORT,
  launchToken,
  staticDir: existsSync(staticDir) ? staticDir : null,
  store,
  fetch,
  clients,
  jobs,
  agents,
  preferences,
  modelSuggestions: () => modelSuggestions(),
  oauth: {
    clientId: CLOUDFLARE_CLIENT_ID,
    redirectUri: CLOUDFLARE_REDIRECT_URI,
    scopes: CLOUDFLARE_SCOPES,
    pending: createPendingAuthStore(),
  },
});

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: PORT }, () => {
  const url = `${ORIGIN}/?t=${launchToken}`;
  console.log(`Switchyard is running at ${url}`);
  if (!process.env.SWITCHYARD_NO_OPEN) open(url).catch(() => {});
});
server.on("error", (e) => {
  console.error(describeListenError(e as NodeJS.ErrnoException, PORT));
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // An agent runs in its own process group, which the terminal's Ctrl+C doesn't reach.
    stopProcessGroups();
    server.close();
    process.exit(0);
  });
}
