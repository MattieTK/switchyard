import type { StepId } from "./types.ts";

// What each step is called and what it does, for the job page and for the model that fixes a
// failed step, which needs to know what has happened and what will happen to its changes.
// The job page imports this file too, so it imports nothing that needs Node.js.
export const STEP_INFO: Record<StepId, { title: string; does: string }> = {
  clone: {
    title: "Clone the repository",
    does: "Clones the production branch from GitHub into a working copy and checks out the cloudflare-migration branch.",
  },
  convert: {
    title: "Convert the project",
    does: "Converts the project to run on Cloudflare Workers, writes cloudflare.config.ts, and adjusts package.json, lockfiles and toolchain files.",
  },
  build: { title: "Build locally with cf", does: "Builds the converted project on this machine with the production build variables." },
  deploy: {
    title: "Create the Worker with a first deploy",
    does: "Runs cf deploy, which builds the project and uploads it as the Worker with its secrets.",
  },
  push: {
    title: "Push the migration branch",
    does: "Commits every change in the working copy to cloudflare-migration and force-pushes that branch to GitHub.",
  },
  pr: { title: "Open the pull request", does: "Opens a pull request from cloudflare-migration into the production branch, listing every change to review." },
  builds: {
    title: "Connect Workers Builds",
    does: "Connects the repository to Workers Builds, so pushes to the production branch deploy and other branches are built.",
  },
  "start-build": {
    title: "Run the first Cloudflare build",
    does: "Builds cloudflare-migration on Workers Builds, Cloudflare's CI, from what was pushed to GitHub.",
  },
};

// Steps whose failures can come from the project's code, which OpenAI can be asked to fix.
export const AI_FIXABLE_STEPS: readonly StepId[] = ["build", "deploy", "start-build"];
