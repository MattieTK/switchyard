import type { BuildInfo } from "../clients/cloudflare.ts";

export type BuildState = "running" | "success" | "failure";

// Status values confirmed by spike 2 (docs/spikes.md). Unknown values count as still running.
const SUCCESS = new Set(["success", "succeeded"]);
const FAILURE = new Set(["fail", "failed", "failure", "cancelled", "canceled", "error", "terminated", "stopped"]);

export function interpretBuild(b: BuildInfo): BuildState {
  const outcome = b.build_outcome?.toLowerCase();
  if (outcome) return SUCCESS.has(outcome) ? "success" : "failure";
  const status = b.status.toLowerCase();
  if (SUCCESS.has(status)) return "success";
  if (FAILURE.has(status)) return "failure";
  return "running";
}

export function buildDashboardUrl(accountId: string, workerName: string, buildUuid: string): string {
  return `https://dash.cloudflare.com/${accountId}/workers/services/view/${workerName}/production/builds/${buildUuid}`;
}
