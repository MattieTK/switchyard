import { Progress } from "@base-ui/react/progress";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Job, StepId, StepState } from "../../../src/pipeline/types.ts";
import { api, apiText, authUrl } from "../api.ts";
import { Button, ButtonLink, Callout, Card, Loading, Pill, Spinner } from "../ui/controls.tsx";
import { CopyIcon, ExternalIcon } from "../ui/icons.tsx";
import { StepChain } from "../ui/StepChain.tsx";

const MAX_LINES = 2000;

const STEP_TITLES: Record<StepId, string> = {
  clone: "Clone the repository",
  convert: "Convert the project",
  build: "Build locally with cf",
  deploy: "Create the Worker with a first deploy",
  push: "Push the migration branch",
  pr: "Open the pull request",
  builds: "Connect Workers Builds",
  "start-build": "Run the first Cloudflare build",
};

const LINK_OUTPUTS: Record<string, string> = {
  prUrl: "Pull request",
  workersDevUrl: "Deployed Worker",
  buildUrl: "Build log",
};

const JOB_STATUS: Record<Job["status"], { label: string; tone: "neutral" | "ok" | "warn" | "err" | "accent" }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "accent" },
  paused: { label: "Needs you", tone: "warn" },
  failed: { label: "Failed", tone: "err" },
  done: { label: "Done", tone: "ok" },
};

// onCheckAgain is passed while the job is paused, so the button sits with the instructions
// that tell the reader to select it, not only in the page header.
function StepDetails({ step, onCheckAgain, busy }: { step: StepState; onCheckAgain?: () => void; busy?: boolean }) {
  const links = Object.entries(step.outputs).filter(([k]) => k in LINK_OUTPUTS);
  if (!links.length && !step.error && !step.pause) return null;
  return (
    <>
      {links.length > 0 && (
        <div className="output-links">
          {links.map(([k, v]) => (
            <a key={k} className="output-link" href={v} target="_blank" rel="noreferrer">
              <span className="output-link-label">{LINK_OUTPUTS[k]}</span>
              <span>{v.replace(/^https?:\/\//, "")}</span>
              <ExternalIcon />
            </a>
          ))}
        </div>
      )}
      {step.error && <Callout tone="error">{step.error}</Callout>}
      {step.pause && (
        <Callout tone="warning">
          <p style={{ margin: 0 }}>{step.pause.reason}</p>
          {(step.pause.actionUrl || step.pause.reconnect || onCheckAgain) && (
            <div className="row" style={{ marginTop: "0.6rem" }}>
              {step.pause.actionUrl && (
                <ButtonLink href={step.pause.actionUrl} target="_blank" rel="noreferrer">
                  {step.pause.actionLabel ?? "Open"} <ExternalIcon />
                </ButtonLink>
              )}
              {onCheckAgain && (
                <Button variant="primary" busy={busy} onClick={onCheckAgain}>
                  Check again
                </Button>
              )}
              {step.pause.reconnect && (
                <span className="small">
                  <a href="#/connect">Reconnect {step.pause.reconnect}</a>, then select Check again.
                </span>
              )}
            </div>
          )}
        </Callout>
      )}
    </>
  );
}

function LogLine({ line }: { line: string }) {
  const match = line.match(/^(\[[a-z-]+\] )(.*)$/);
  if (!match) return <>{line}</>;
  const [, prefix, rest = ""] = match;
  return (
    <>
      <span className="log-step">{prefix}</span>
      <span className={rest.startsWith("Warning:") ? "log-warning" : undefined}>{rest}</span>
    </>
  );
}

function Log({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // Follow new output while the reader is at the bottom, and leave them alone once they scroll up.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <div
      ref={ref}
      className="log"
      role="log"
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {lines.length === 0
        ? "No output yet."
        : lines.map((l, i) => (
            <div key={i}>
              <LogLine line={l} />
            </div>
          ))}
    </div>
  );
}

export function JobPage({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [logCopied, setLogCopied] = useState(false);

  useEffect(() => {
    let source: EventSource | null = null;
    let cancelled = false;
    // Load the saved log first, then follow new events.
    apiText(`/api/jobs/${jobId}/log`)
      .then((text) => {
        if (cancelled) return;
        setLines(text.split("\n").filter(Boolean).slice(-MAX_LINES));
        source = new EventSource(authUrl(`/api/jobs/${jobId}/events`));
        source.addEventListener("job", (e) => setJob(JSON.parse((e as MessageEvent<string>).data) as Job));
        source.addEventListener("log", (e) => {
          const { step, line } = JSON.parse((e as MessageEvent<string>).data) as { step: StepId; line: string };
          setLines((l) => [...l, `[${step}] ${line}`].slice(-MAX_LINES));
        });
        source.addEventListener("error", (e) => {
          // A server-sent error event carries a message; a native connection error does not.
          const message = (e as MessageEvent<string | undefined>).data;
          if (typeof message === "string" && message) {
            setError(message);
            source?.close();
          } else if (source?.readyState === EventSource.CLOSED) {
            setError("Lost the connection to Switchyard. Reload to reconnect.");
          }
        });
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
      source?.close();
    };
  }, [jobId]);

  // Retry runs the step that stopped again; restart runs every step again from the clone.
  const requeue = async (action: "retry" | "restart") => {
    setBusy(true);
    // A restart clears the saved log. Clearing the lines first means the new run's first
    // lines, which can arrive before the response, aren't cleared along with the old ones.
    if (action === "restart") setLines([]);
    try {
      setJob(await api<Job>(`/api/jobs/${jobId}/${action}`, { method: "POST" }));
    } catch (e) {
      setError((e as Error).message);
      // The log is unchanged when the restart was refused, so show it again.
      if (action === "restart") {
        void apiText(`/api/jobs/${jobId}/log`)
          .then((text) => setLines(text.split("\n").filter(Boolean).slice(-MAX_LINES)))
          .catch(() => {});
      }
    } finally {
      setBusy(false);
    }
  };

  // Copies the whole saved log, which can be longer than the lines shown here.
  const copyLog = async () => {
    try {
      const text = await apiText(`/api/jobs/${jobId}/log`).catch(() => lines.join("\n"));
      await navigator.clipboard.writeText(text);
      setLogCopied(true);
      setTimeout(() => setLogCopied(false), 1500);
    } catch (e) {
      setError(`Couldn't copy the log: ${(e as Error).message}`);
    }
  };

  if (!job) {
    return <main>{error ? <Callout tone="error">{error}</Callout> : <Loading>Loading the migration…</Loading>}</main>;
  }

  const workingCopy = job.steps.find((s) => s.id === "clone")?.outputs.dir;
  const done = job.steps.filter((s) => s.status === "done").length;
  const status = JOB_STATUS[job.status];
  const canRetry = job.status === "failed" || job.status === "paused";

  return (
    <main className="main-wide">
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <h1>Moving {job.plan.projectName}</h1>
            <p className="lede">
              To the Worker <code>{job.plan.workerName}</code>
              {job.plan.repo && (
                <>
                  {" "}
                  from <code>{`${job.plan.repo.owner}/${job.plan.repo.name}`}</code>
                </>
              )}
            </p>
          </div>
          <div className="row">
            <Pill tone={status.tone}>
              {job.status === "running" && <Spinner size="sm" />}
              {status.label}
            </Pill>
            {canRetry && (
              <Button busy={busy} onClick={() => void requeue("restart")} title="Run every step again, from the clone">
                Start over
              </Button>
            )}
            {canRetry && (
              <Button variant="primary" busy={busy} onClick={() => void requeue("retry")}>
                {job.status === "paused" ? "Check again" : "Retry"}
              </Button>
            )}
          </div>
        </div>
        <Progress.Root className="progress" value={(done / job.steps.length) * 100} data-tone={job.status}>
          <div className="progress-label">
            <Progress.Label>
              {done} of {job.steps.length} steps done
            </Progress.Label>
          </div>
          <Progress.Track className="progress-track">
            <Progress.Indicator className="progress-indicator" />
          </Progress.Track>
        </Progress.Root>
      </div>

      {error && <Callout tone="error">{error}</Callout>}

      {/* Steps on the left and the log beside them on wide screens, stacked on narrow ones. */}
      <div className="job-layout">
        <div className="stack">
          <Card>
            <StepChain
              steps={job.steps.map((s) => ({
                id: s.id,
                title: STEP_TITLES[s.id],
                status: s.status,
                details: (
                  <StepDetails
                    step={s}
                    busy={busy}
                    onCheckAgain={job.status === "paused" && s.pause ? () => void requeue("retry") : undefined}
                  />
                ),
              }))}
            />
          </Card>

          {workingCopy && (
            <Card>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div style={{ minWidth: 0 }}>
                  <div className="small muted">Working copy</div>
                  <code style={{ wordBreak: "break-all" }}>{workingCopy}</code>
                </div>
                <Button
                  variant="ghost"
                  onClick={() => {
                    void navigator.clipboard.writeText(workingCopy).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    });
                  }}
                >
                  <CopyIcon /> {copied ? "Copied" : "Copy path"}
                </Button>
              </div>
            </Card>
          )}
        </div>

        <Card
          className="log-card"
          title="Log"
          aside={
            <div className="row">
              <span className="muted small">{lines.length} lines</span>
              <Button variant="ghost" onClick={() => void copyLog()} disabled={lines.length === 0}>
                <CopyIcon /> {logCopied ? "Copied" : "Copy log"}
              </Button>
            </div>
          }
        >
          <Log lines={lines} />
        </Card>
      </div>
    </main>
  );
}
