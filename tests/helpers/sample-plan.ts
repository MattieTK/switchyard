import type { MigrationPlan } from "../../src/pipeline/plan.ts";

export const samplePlan: MigrationPlan = {
  projectId: "prj_1",
  projectName: "shop",
  workerName: "shop",
  repo: { owner: "acme", name: "shop", productionBranch: "main", rootDirectory: "" },
  packageManager: "pnpm",
  adapterId: "nextjs",
  support: { level: "supported" },
  nextCache: "kv",
  env: { entries: [], warnings: [] },
  vercelJson: { crons: [], manual: [] },
  storage: [],
  features: [],
  domains: [],
  blockers: [],
};
