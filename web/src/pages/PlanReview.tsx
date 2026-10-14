import { useEffect, useState } from "react";
import type { MigrationPlan } from "../../../src/pipeline/plan.ts";
import type { Job } from "../../../src/pipeline/types.ts";
import type { EnvDestination } from "../../../src/translate/env-plan.ts";
import { api, ApiFailure } from "../api.ts";
import { go } from "../router.ts";

const DESTINATIONS: Record<EnvDestination, string> = {
  "production-build": "production build",
  "preview-build": "preview build",
  "runtime-secret": "Worker secret",
  "dev-vars": ".dev.vars (local only)",
};

export function PlanReview({ projectId, next }: { projectId: string; next: string[] }) {
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [workerName, setWorkerName] = useState("");
  const [nextCache, setNextCache] = useState<"kv" | "none">("kv");
  const [values, setValues] = useState<Record<string, string>>({});
  const [skip, setSkip] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<MigrationPlan>(`/api/projects/${encodeURIComponent(projectId)}/plan`, { method: "POST" })
      .then((p) => {
        setPlan(p);
        setWorkerName(p.workerName);
      })
      .catch((e: ApiFailure) => setError(e));
  }, [projectId]);

  if (error && !plan) {
    return (
      <main>
        <p className="error">
          {error.message} {error.reconnect && <a href="#/connect">Reconnect {error.reconnect}</a>}
        </p>
      </main>
    );
  }
  if (!plan) {
    return (
      <main>
        <p>Reading the project from Vercel, GitHub and Cloudflare…</p>
      </main>
    );
  }

  const needsInput = plan.env.entries.filter((e) => e.needsInput);
  const unresolved = needsInput.filter((e) => !values[e.id] && !skip.includes(e.id));
  const canApprove = plan.blockers.length === 0 && unresolved.length === 0 && workerName.length > 0 && !busy;

  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      const job = await api<Job>("/api/jobs", {
        method: "POST",
        body: { projectId, workerName, nextCache, values, skip },
      });
      const [following, ...rest] = next;
      go(following ? `#/plan/${following}${rest.length ? `?next=${rest.join(",")}` : ""}` : `#/jobs/${job.id}`);
    } catch (e) {
      setError(e as ApiFailure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <h1>Plan for {plan.projectName}</h1>
      <p className="lede">Nothing has changed yet. Review the plan, fill in anything missing, then approve.</p>

      {plan.warnings.length > 0 && (
        <section className="card">
          <h2 className="warning">Check before approving</h2>
          <ul>
            {plan.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </section>
      )}

      {plan.blockers.length > 0 && (
        <section className="card">
          <h2 className="error">This project can't be moved yet</h2>
          <ul>
            {plan.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>Project</h2>
        <p>
          {plan.repo ? (
            <>
              Repository <code>{`${plan.repo.owner}/${plan.repo.name}`}</code>, production branch{" "}
              <code>{plan.repo.productionBranch}</code>
              {plan.repo.rootDirectory && (
                <>
                  , folder <code>{plan.repo.rootDirectory}</code>
                </>
              )}
              . Package manager: {plan.packageManager}.
            </>
          ) : (
            "No repository."
          )}
        </p>
        <p>
          Converter: {plan.adapterId === "nextjs" ? "Next.js with vinext" : "none"} ({plan.support.level}
          {plan.support.reason ? ` – ${plan.support.reason}` : ""}).
        </p>
        <label>
          Worker name <input type="text" value={workerName} onChange={(e) => setWorkerName(e.target.value)} />
        </label>
        {plan.adapterId === "nextjs" && (
          <fieldset>
            <legend>Next.js caching</legend>
            <label>
              <input type="radio" checked={nextCache === "kv"} onChange={() => setNextCache("kv")} /> KV data cache – closest
              to Vercel's ISR and <code>fetch</code> cache
            </label>
            <label>
              <input type="radio" checked={nextCache === "none"} onChange={() => setNextCache("none")} /> No cache
            </label>
          </fieldset>
        )}
      </section>

      <section className="card">
        <h2>Environment variables</h2>
        {plan.env.warnings.map((w) => (
          <p key={w} className="warning">
            {w}
          </p>
        ))}
        {plan.env.entries.length === 0 ? (
          <p>This project has no environment variables.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Vercel</th>
                <th>Goes to</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {plan.env.entries.map((e) => (
                <tr key={e.id}>
                  <td>
                    <code>{e.key}</code>
                  </td>
                  <td>
                    {e.targets.join(", ")} ({e.vercelType})
                  </td>
                  <td>{e.skipReason ? <span className="warning">Not copied: {e.skipReason}</span> : e.destinations.map((d) => DESTINATIONS[d]).join(", ")}</td>
                  <td>
                    {e.needsInput ? (
                      <>
                        <input
                          type="password"
                          autoComplete="off"
                          aria-label={`Value for ${e.key}`}
                          disabled={skip.includes(e.id)}
                          value={values[e.id] ?? ""}
                          onChange={(ev) => setValues((v) => ({ ...v, [e.id]: ev.target.value }))}
                        />{" "}
                        <label>
                          <input
                            type="checkbox"
                            checked={skip.includes(e.id)}
                            onChange={() => setSkip((s) => (s.includes(e.id) ? s.filter((x) => x !== e.id) : [...s, e.id]))}
                          />{" "}
                          Skip
                        </label>
                      </>
                    ) : e.skipReason ? (
                      "–"
                    ) : (
                      <span className="ok">Copied from Vercel</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {(plan.vercelJson.crons.length > 0 || plan.vercelJson.manual.length > 0) && (
        <section className="card">
          <h2>vercel.json</h2>
          {plan.vercelJson.crons.length > 0 && (
            <>
              <p>These cron jobs become Cron Triggers:</p>
              <ul>
                {plan.vercelJson.crons.map((c) => (
                  <li key={`${c.schedule} ${c.path}`}>
                    <code>{c.schedule}</code> → <code>{c.path}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          {plan.vercelJson.manual.length > 0 && (
            <>
              <p>These need moving by hand. They'll be listed in the pull request:</p>
              <ul>
                {plan.vercelJson.manual.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {plan.features.length > 0 && (
        <section className="card">
          <h2>Vercel-only features</h2>
          <ul>
            {plan.features.map((f) => (
              <li key={f.package}>
                <code>{f.package}</code>: {f.note}
              </li>
            ))}
          </ul>
        </section>
      )}

      {plan.storage.length > 0 && (
        <section className="card">
          <h2>Storage</h2>
          <ul>
            {plan.storage.map((s) => (
              <li key={s.kind}>
                <strong>{s.label}</strong> (found {s.evidence.join(", ")}): {s.suggestion}
              </li>
            ))}
          </ul>
          <p className="lede">Moving storage to R2, KV or D1 will be offered in a later version.</p>
        </section>
      )}

      {plan.domains.length > 0 && (
        <section className="card">
          <h2>Domains</h2>
          <p className="lede">Domains stay on Vercel for now. They move during cut-over, after the pull request merges.</p>
          <ul>
            {plan.domains.map((d) => (
              <li key={d.name}>
                <code>{d.name}</code> –{" "}
                {d.zone ? `its zone ${d.zone} is on your Cloudflare account` : "its zone isn't on your Cloudflare account"}
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && <p className="error">{error.message}</p>}
      {unresolved.length > 0 && (
        <p className="warning">Enter a value, or choose Skip, for: {unresolved.map((e) => e.key).join(", ")}.</p>
      )}
      <button className="primary" disabled={!canApprove} onClick={() => void approve()}>
        {busy ? "Starting…" : "Approve and run"}
      </button>
    </main>
  );
}
