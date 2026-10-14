import { useEffect, useState } from "react";
import type { Job } from "../../../src/pipeline/types.ts";
import type { ProjectSummary } from "../../../src/server/routes/jobs.ts";
import { api, ApiFailure } from "../api.ts";
import { go } from "../router.ts";
import { Button, Callout, Card, Checkbox, Hint, Loading, Pill } from "../ui/controls.tsx";
import { ArrowIcon } from "../ui/icons.tsx";
import { MiniChain } from "../ui/StepChain.tsx";

const SUPPORT = {
  supported: { label: "Supported", tone: "ok" },
  partial: { label: "Partial", tone: "warn" },
  unsupported: { label: "Not yet", tone: "neutral" },
} as const;

const JOB_STATUS = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "accent" },
  paused: { label: "Needs you", tone: "warn" },
  failed: { label: "Failed", tone: "err" },
  done: { label: "Done", tone: "ok" },
} as const;

export function Projects() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<ApiFailure | null>(null);

  useEffect(() => {
    api<ProjectSummary[]>("/api/projects")
      .then(setProjects)
      .catch((e: ApiFailure) => setError(e));
    api<Job[]>("/api/jobs")
      .then(setJobs)
      .catch(() => setJobs([]));
  }, []);

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const planSelected = () => {
    const [first, ...rest] = selected;
    if (first) go(`#/plan/${first}${rest.length ? `?next=${rest.join(",")}` : ""}`);
  };

  return (
    <main>
      <div className="page-head">
        <h1>Choose projects to move</h1>
        <p className="lede">
          Select one or more projects. You'll review a plan for each before anything changes, and they run one after another.
        </p>
      </div>

      <div className="stack">
        {error && (
          <Callout tone="error">
            {error.message} {error.reconnect && <a href="#/connect">Reconnect {error.reconnect}</a>}
          </Callout>
        )}
        {!projects && !error && <Loading>Loading your Vercel projects…</Loading>}
        {projects && projects.length === 0 && <div className="empty">This Vercel token can't see any projects.</div>}
        {projects && projects.length > 0 && (
          <Card
            title="Vercel projects"
            aside={
              <Button variant="primary" disabled={!selected.length} onClick={planSelected}>
                Review plan{selected.length > 1 ? `s (${selected.length})` : ""} <ArrowIcon />
              </Button>
            }
          >
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th aria-label="Select" />
                    <th>Project</th>
                    <th>Framework</th>
                    <th>Repository</th>
                    <th>Support</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => {
                    const disabled = p.support.level === "unsupported" || !p.repo;
                    const support = SUPPORT[p.support.level];
                    return (
                      <tr key={p.id} data-selected={selected.includes(p.id) || undefined}>
                        <td className="cell-check">
                          <Checkbox
                            aria-label={`Select ${p.name}`}
                            disabled={disabled}
                            checked={selected.includes(p.id)}
                            onChange={() => toggle(p.id)}
                          />
                        </td>
                        <td>
                          <strong>{p.name}</strong>
                        </td>
                        <td>{p.framework ?? <span className="muted">–</span>}</td>
                        <td>
                          {p.repo ? (
                            <>
                              <code>{p.repo}</code>
                              {p.productionBranch && <div className="muted">{p.productionBranch}</div>}
                            </>
                          ) : (
                            <span className="muted">Not linked to Git</span>
                          )}
                        </td>
                        <td>
                          <Hint text={p.support.reason}>
                            <Pill tone={support.tone}>{support.label}</Pill>
                          </Hint>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {jobs.length > 0 && (
          <Card title="Migrations">
            <div className="table-wrap">
              <table>
                <tbody>
                  {jobs.map((j) => {
                    const status = JOB_STATUS[j.status];
                    return (
                      <tr key={j.id}>
                        <td>
                          <a href={`#/jobs/${j.id}`}>
                            <strong>{j.plan.projectName}</strong>
                          </a>
                          <div className="muted">{new Date(j.createdAt).toLocaleString("en-GB")}</div>
                        </td>
                        <td>
                          <MiniChain statuses={j.steps.map((s) => s.status)} />
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <Pill tone={status.tone}>{status.label}</Pill>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </main>
  );
}
