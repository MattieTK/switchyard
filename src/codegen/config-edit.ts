import { builders, generateCode, parseModule, type ProxifiedModule } from "magicast";
import type { CronJob } from "../translate/vercel-json.ts";

export interface ConfigEdits {
  workerName: string;
  secretKeys: readonly string[];
  crons: readonly CronJob[];
  entrypoint?: string;
}

export class ConfigEditError extends Error {
  constructor(message: string) {
    super(`Couldn't update cloudflare.config.ts: ${message}`);
    this.name = "ConfigEditError";
  }
}

function ensureImport(mod: ProxifiedModule, name: string): void {
  if (!(name in mod.imports)) mod.imports.$prepend({ from: "cf/config", imported: name });
}

// Edits the config the converter generated, through the syntax tree rather
// than with string replacement, so formatting and unrelated settings survive.
export function editCloudflareConfig(source: string, edits: ConfigEdits): string {
  const mod = parseModule(source);
  const exported = mod.exports.default;
  if (!exported || exported.$type !== "function-call") {
    throw new ConfigEditError("expected `export default defineConfig({ ... })`");
  }
  const workerNode = exported.$args[0]?.worker;
  if (!workerNode) throw new ConfigEditError("no `worker` entry was found");
  const worker = workerNode.$type === "function-call" ? workerNode.$args[0] : workerNode;

  worker.name = edits.workerName;
  if (edits.entrypoint) worker.entrypoint = edits.entrypoint;

  if (edits.secretKeys.length) {
    if (!worker.env) worker.env = {};
    for (const key of edits.secretKeys) {
      if (!(key in worker.env)) worker.env[key] = builders.raw("bindings.secret()");
    }
    ensureImport(mod, "bindings");
  }

  const schedules = [...new Set(edits.crons.map((c) => c.schedule))];
  if (schedules.length) {
    const items = schedules.map((s) => builders.raw(`triggers.scheduled({ schedule: ${JSON.stringify(s)} })`));
    if (worker.triggers) for (const item of items) worker.triggers.push(item);
    else worker.triggers = items;
    ensureImport(mod, "triggers");
  }

  return generateCode(mod).code;
}
