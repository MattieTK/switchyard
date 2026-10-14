import { useEffect, useState } from "react";
import type { Job } from "../../../src/pipeline/types.ts";
import type { ProjectSummary } from "../../../src/server/routes/jobs.ts";
import { api, ApiFailure } from "../api.ts";
import { go } from "../router.ts";

const SUPPORT_LABELS = { supported: "Supported", partial: "Partial", unsupported: "Not yet" } as const;

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
      <h1>Choose projects to move</h1>
      {error && (
        <p className="error">
          {error.message} {error.reconnect && <a href="#/connect">Reconnect {error.reconnect}</a>}
        </p>
      )}
      {!projects && !error && <p>Loading your Vercel projects…</p>}
      {projects && projects.length === 0 && <p>This Vercel token can't see any projects.</p>}
      {projects && projects.length > 0 && (
        <>
          <p className="lede">
            Select one or more projects. You'll review a plan for each before anything changes, and they run one after
            another.
          </p>
          <table>
            <thead>
              <tr>
                <th />
                <th>Project</th>
                <th>Framework</th>
                <th>Repository</th>
                <th>Production branch</th>
                <th>Support</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${p.name}`}
                      disabled={p.support.level === "unsupported" || !p.repo}
                      checked={selected.includes(p.id)}
                      onChange={() => toggle(p.id)}
                    />
                  </td>
                  <td>{p.name}</td>
                  <td>{p.framework ?? "–"}</td>
                  <td>{p.repo ?? "Not linked to Git"}</td>
                  <td>{p.productionBranch ?? "–"}</td>
                  <td>
                    <span className="badge" title={p.support.reason}>
                      {SUPPORT_LABELS[p.support.level]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            <button className="primary" disabled={!selected.length} onClick={planSelected}>
              Review plan{selected.length > 1 ? `s (${selected.length})` : ""}
            </button>
          </p>
        </>
      )}
      {jobs.length > 0 && (
        <section>
          <h2>Migrations</h2>
          <table>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>
                    <a href={`#/jobs/${j.id}`}>{j.plan.projectName}</a>
                  </td>
                  <td>{j.status}</td>
                  <td>{new Date(j.createdAt).toLocaleString("en-GB")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
