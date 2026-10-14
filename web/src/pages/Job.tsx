import { useEffect, useState } from "react";
import type { Job, StepId, StepState } from "../../../src/pipeline/types.ts";
import { api, apiText, authUrl } from "../api.ts";

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

const STATUS_LABELS: Record<StepState["status"], string> = {
  pending: "Waiting",
  running: "Running",
  done: "Done",
  failed: "Failed",
  paused: "Needs you",
};

const LINK_OUTPUTS: Record<string, string> = {
  prUrl: "Pull request",
  workersDevUrl: "Deployed Worker",
  buildUrl: "Build log",
};

export function JobPage({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const retry = async () => {
    setBusy(true);
    try {
      setJob(await api<Job>(`/api/jobs/${jobId}/retry`, { method: "POST" }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!job) {
    return (
      <main>
        <p className={error ? "error" : ""}>{error ?? "Loading…"}</p>
      </main>
    );
  }
  const workingCopy = job.steps.find((s) => s.id === "clone")?.outputs.dir;

  return (
    <main>
      <h1>Moving {job.plan.projectName}</h1>
      <p className="lede">Status: {job.status}</p>
      {error && <p className="error">{error}</p>}
      <ol className="steps">
        {job.steps.map((s) => (
          <li key={s.id}>
            <strong>{STEP_TITLES[s.id]}</strong> – <span className={s.status === "failed" ? "error" : s.status === "paused" ? "warning" : s.status === "done" ? "ok" : ""}>{STATUS_LABELS[s.status]}</span>
            {Object.entries(s.outputs)
              .filter(([k]) => k in LINK_OUTPUTS)
              .map(([k, v]) => (
                <div key={k}>
                  {LINK_OUTPUTS[k]}:{" "}
                  <a href={v} target="_blank" rel="noreferrer">
                    {v}
                  </a>
                </div>
              ))}
            {s.error && <p className="error">{s.error}</p>}
            {s.pause && (
              <div className="warning">
                <p>{s.pause.reason}</p>
                {s.pause.actionUrl && (
                  <p>
                    <a className="button" href={s.pause.actionUrl} target="_blank" rel="noreferrer">
                      {s.pause.actionLabel ?? "Open"}
                    </a>
                  </p>
                )}
                {s.pause.reconnect && (
                  <p>
                    <a href="#/connect">Reconnect {s.pause.reconnect}</a>, then select Check again.
                  </p>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
      {(job.status === "failed" || job.status === "paused") && (
        <button className="primary" disabled={busy} onClick={() => void retry()}>
          {job.status === "paused" ? "Check again" : "Retry"}
        </button>
      )}
      {workingCopy && (
        <p>
          Working copy: <code>{workingCopy}</code>{" "}
          <button onClick={() => void navigator.clipboard.writeText(workingCopy)}>Copy path</button>
        </p>
      )}
      <h2>Log</h2>
      <div className="log" role="log">
        {lines.join("\n") || "No output yet."}
      </div>
    </main>
  );
}
