import type { Step } from "../types.ts";
import { buildsStep, startBuildStep } from "./builds.ts";
import { deployStep, prStep, pushStep } from "./release.ts";
import { buildStep, cloneStep, convertStep } from "./repo.ts";

export const STEPS: readonly Step[] = [
  cloneStep,
  convertStep,
  buildStep,
  deployStep,
  pushStep,
  prStep,
  buildsStep,
  startBuildStep,
];
