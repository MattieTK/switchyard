import type { ReactNode } from "react";
import type { StepState } from "../../../src/pipeline/types.ts";
import { AlertIcon, CheckIcon, CrossIcon } from "./icons.tsx";

export const STATUS_LABELS: Record<StepState["status"], string> = {
  pending: "Waiting",
  running: "Running",
  done: "Done",
  failed: "Failed",
  paused: "Needs you",
};

function Node({ status, index }: { status: StepState["status"]; index: number }) {
  return (
    <span className="chain-node" aria-hidden>
      {status === "done" ? (
        <CheckIcon />
      ) : status === "failed" ? (
        <CrossIcon />
      ) : status === "paused" ? (
        <AlertIcon />
      ) : status === "running" ? (
        <span className="chain-node-pulse" />
      ) : (
        index + 1
      )}
    </span>
  );
}

export interface ChainStep {
  id: string;
  title: string;
  status: StepState["status"];
  details?: ReactNode;
}

// The migration steps as connected nodes. The connector below each node shows how
// far the work has travelled: solid when done, moving while the step runs.
export function StepChain({ steps }: { steps: ChainStep[] }) {
  return (
    <ol className="chain">
      {steps.map((s, i) => (
        <li key={s.id} className="chain-step" data-status={s.status} aria-current={s.status === "running" ? "step" : undefined}>
          <div className="chain-rail">
            <Node status={s.status} index={i} />
            {i < steps.length - 1 && <span className="chain-line" />}
          </div>
          <div className="chain-body">
            <div className="chain-head">
              <span className="chain-title">{s.title}</span>
              <span className="chain-status">{STATUS_LABELS[s.status]}</span>
            </div>
            {s.details && <div className="chain-details">{s.details}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

// A compact version for lists: one dot per step, joined by short lines.
export function MiniChain({ statuses }: { statuses: StepState["status"][] }) {
  const done = statuses.filter((s) => s === "done").length;
  return (
    <span className="mini-chain" role="img" aria-label={`${done} of ${statuses.length} steps done`}>
      {statuses.map((s, i) => (
        <span key={i} className="mini-chain-dot" data-status={s} />
      ))}
    </span>
  );
}
