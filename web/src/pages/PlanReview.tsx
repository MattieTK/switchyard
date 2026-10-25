import { Input } from "@base-ui/react/input";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { type ReactNode, useEffect, useState } from "react";
import type { MigrationPlan, PlanOptions } from "../../../src/pipeline/plan.ts";
import type { Job } from "../../../src/pipeline/types.ts";
import type { EnvDestination } from "../../../src/translate/env-plan.ts";
import { api, ApiFailure } from "../api.ts";
import { go } from "../router.ts";
import { Button, Callout, Card, Checkbox, Loading, Pill, TextField } from "../ui/controls.tsx";
import { ArrowIcon } from "../ui/icons.tsx";

const DESTINATIONS: Record<EnvDestination, string> = {
  "production-build": "production build",
  "preview-build": "preview build",
  "runtime-secret": "Worker secret",
  "dev-vars": ".dev.vars (local only)",
};

const SUPPORT_TONE = { supported: "ok", partial: "warn", unsupported: "neutral" } as const;

const NO_OPTIONS: PlanOptions = { adoptionCodemods: false, eslintMigration: false, updateFlaggedPackages: false, switchToPnpm: false };

// The opt-ins that apply when Switchyard upgrades Next.js.
const UPGRADE_OPTIONS: { key: Exclude<keyof PlanOptions, "switchToPnpm">; label: string; description: string }[] = [
  {
    key: "adoptionCodemods",
    label: "Adoption codemods",
    description: "Also run the optional codemods that move the app onto newer Next.js features. More code changes to review.",
  },
  {
    key: "eslintMigration",
    label: "ESLint migration",
    description:
      "Move from next lint, which Next.js 16 removed, to the ESLint CLI with the Next.js codemod. It can fail on some older ESLint configs.",
  },
  {
    key: "updateFlaggedPackages",
    label: "Update flagged packages",
    description:
      "Update packages the upgrade reports as incompatible with the new React to the first release that supports it. These can be major updates.",
  },
];

function OptionRow({
  checked,
  onChange,
  label,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="radio-option">
      <Checkbox checked={checked} onChange={onChange} aria-label={label} />
      <span>
        <strong>{label}</strong>
        <br />
        <span className="muted">{children}</span>
      </span>
    </label>
  );
}

export function PlanReview({ projectId, next }: { projectId: string; next: string[] }) {
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [workerName, setWorkerName] = useState("");
  const [nextCache, setNextCache] = useState<"kv" | "none">("kv");
  const [values, setValues] = useState<Record<string, string>>({});
  const [skip, setSkip] = useState<string[]>([]);
  const [options, setOptions] = useState<PlanOptions>(NO_OPTIONS);
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
        <Callout tone="error">
          {error.message} {error.reconnect && <a href="#/connect">Reconnect {error.reconnect}</a>}
        </Callout>
      </main>
    );
  }
  if (!plan) {
    return (
      <main>
        <Loading>Reading the project from Vercel, GitHub and Cloudflare…</Loading>
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
        body: { projectId, workerName, nextCache, values, skip, options },
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
      <div className="page-head">
        <h1>Plan for {plan.projectName}</h1>
        <p className="lede">Nothing has changed yet. Review the plan, fill in anything missing, then approve.</p>
      </div>

      <div className="stack">
        {plan.blockers.length > 0 && (
          <Callout tone="error" title="This project can't be moved yet">
            <ul>
              {plan.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </Callout>
        )}

        {plan.warnings.length > 0 && (
          <Callout tone="warning" title="Check before approving">
            <ul>
              {plan.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Callout>
        )}

        <Card title="Project">
          <dl className="facts">
            <dt>Repository</dt>
            <dd>
              {plan.repo ? (
                <>
                  <code>{`${plan.repo.owner}/${plan.repo.name}`}</code>
                  {plan.repo.rootDirectory && (
                    <>
                      {" "}
                      in <code>{plan.repo.rootDirectory}</code>
                    </>
                  )}
                </>
              ) : (
                "No repository"
              )}
            </dd>
            {plan.repo && (
              <>
                <dt>Production branch</dt>
                <dd>
                  <code>{plan.repo.productionBranch}</code>
                </dd>
                <dt>Package manager</dt>
                <dd>{plan.packageManager}</dd>
              </>
            )}
            <dt>Converter</dt>
            <dd className="row">
              {plan.adapterId === "nextjs" ? "Next.js with vinext" : "None"}
              <Pill tone={SUPPORT_TONE[plan.support.level]}>{plan.support.level}</Pill>
              {plan.support.reason && <span className="muted small">{plan.support.reason}</span>}
            </dd>
          </dl>
          <TextField label="Worker name" value={workerName} onValueChange={setWorkerName} />
          {plan.adapterId === "nextjs" && (
            <div className="field" style={{ maxWidth: "none" }}>
              <div className="field-label" id="next-cache-label">
                Next.js caching
              </div>
              <RadioGroup
                className="radio-group"
                aria-labelledby="next-cache-label"
                value={nextCache}
                onValueChange={(v) => setNextCache(v as "kv" | "none")}
              >
                <label className="radio-option">
                  <Radio.Root value="kv" className="radio">
                    <Radio.Indicator className="radio-indicator" />
                  </Radio.Root>
                  <span>
                    <strong>KV data cache</strong>
                    <br />
                    <span className="muted">
                      Closest to Vercel's ISR and <code>fetch</code> cache
                    </span>
                  </span>
                </label>
                <label className="radio-option">
                  <Radio.Root value="none" className="radio">
                    <Radio.Indicator className="radio-indicator" />
                  </Radio.Root>
                  <span>
                    <strong>No cache</strong>
                  </span>
                </label>
              </RadioGroup>
            </div>
          )}
        </Card>

        {(plan.upgrade || plan.pnpmSwitch?.available) && (
          <Card title="Upgrade options">
            <p className="note">
              {plan.upgrade ? (
                <>
                  Switchyard upgrades Next.js from <code>{plan.upgrade.from}</code> to <code>{plan.upgrade.to}</code>. With nothing
                  chosen, it runs only the migrations Next.js 16 requires.
                </>
              ) : (
                "Nothing is chosen by default."
              )}
            </p>
            <div className="radio-group">
              {plan.upgrade &&
                UPGRADE_OPTIONS.map((o) => (
                  <OptionRow
                    key={o.key}
                    label={o.label}
                    checked={options[o.key]}
                    onChange={(c) => setOptions((current) => ({ ...current, [o.key]: c }))}
                  >
                    {o.description}
                  </OptionRow>
                ))}
              {plan.pnpmSwitch?.available && (
                <OptionRow
                  label="Switch to pnpm"
                  checked={options.switchToPnpm}
                  onChange={(c) => setOptions((current) => ({ ...current, switchToPnpm: c }))}
                >
                  {plan.pnpmSwitch.reresolves
                    ? `Move the project from ${plan.packageManager} to pnpm. Its lockfile can't be imported, so pnpm will choose dependency versions again.`
                    : `Move the project from ${plan.packageManager} to pnpm with pnpm import, which keeps the current dependency versions.`}
                  {plan.pnpmSwitch.hint && (
                    <>
                      {" "}
                      {plan.pnpmSwitch.hint}
                    </>
                  )}
                </OptionRow>
              )}
            </div>
            {plan.pnpmSwitch && !plan.pnpmSwitch.available && <p className="note">Switching to pnpm isn't offered: {plan.pnpmSwitch.reason}</p>}
          </Card>
        )}

        <Card title="Environment variables" aside={<span className="muted small">{plan.env.entries.length} found</span>}>
          {plan.env.warnings.map((w) => (
            <Callout key={w} tone="warning">
              {w}
            </Callout>
          ))}
          {plan.env.entries.length === 0 ? (
            <p className="muted">This project has no environment variables.</p>
          ) : (
            <div className="table-wrap">
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
                        {e.targets.join(", ")}
                        <div className="muted">{e.vercelType}</div>
                      </td>
                      <td>
                        {e.skipReason ? (
                          <Pill tone="warn">Not copied: {e.skipReason}</Pill>
                        ) : (
                          e.destinations.map((d) => DESTINATIONS[d]).join(", ")
                        )}
                      </td>
                      <td>
                        {e.needsInput ? (
                          <div className="row">
                            <Input
                              className="input input-inline"
                              type="password"
                              autoComplete="off"
                              aria-label={`Value for ${e.key}`}
                              disabled={skip.includes(e.id)}
                              value={values[e.id] ?? ""}
                              onValueChange={(v) => setValues((vals) => ({ ...vals, [e.id]: v }))}
                            />
                            <Checkbox
                              label="Skip"
                              checked={skip.includes(e.id)}
                              onChange={() => setSkip((s) => (s.includes(e.id) ? s.filter((x) => x !== e.id) : [...s, e.id]))}
                            />
                          </div>
                        ) : e.skipReason ? (
                          <span className="muted">–</span>
                        ) : (
                          <Pill tone="ok">Copied from Vercel</Pill>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {(plan.vercelJson.crons.length > 0 || plan.vercelJson.manual.length > 0) && (
          <Card title={<code>vercel.json</code>}>
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
          </Card>
        )}

        {plan.features.length > 0 && (
          <Card title="Vercel-only features">
            <ul>
              {plan.features.map((f) => (
                <li key={f.package}>
                  <code>{f.package}</code>: {f.note}
                </li>
              ))}
            </ul>
          </Card>
        )}

        {plan.storage.length > 0 && (
          <Card title="Storage">
            <ul>
              {plan.storage.map((s) => (
                <li key={s.kind}>
                  <strong>{s.label}</strong> (found {s.evidence.join(", ")}): {s.suggestion}
                </li>
              ))}
            </ul>
            <p className="note">Moving storage to R2, KV or D1 will be offered in a later version.</p>
          </Card>
        )}

        {plan.domains.length > 0 && (
          <Card title="Domains">
            <p className="note">Domains stay on Vercel for now. They move during cut-over, after the pull request merges.</p>
            <ul>
              {plan.domains.map((d) => (
                <li key={d.name}>
                  <code>{d.name}</code> –{" "}
                  {d.zone ? `its zone ${d.zone} is on your Cloudflare account` : "its zone isn't on your Cloudflare account"}
                </li>
              ))}
            </ul>
          </Card>
        )}

        {error && <Callout tone="error">{error.message}</Callout>}
      </div>

      <div className="action-bar">
        <p className="note">
          {unresolved.length > 0
            ? `Enter a value, or choose Skip, for: ${[...new Set(unresolved.map((e) => e.key))].join(", ")}.`
            : plan.blockers.length > 0
              ? "Resolve the blockers above first."
              : "Approving starts the migration. Your Vercel deployment isn't changed."}
        </p>
        <Button variant="primary" busy={busy} disabled={!canApprove} onClick={() => void approve()}>
          {busy ? "Starting…" : "Approve and run"} {!busy && <ArrowIcon />}
        </Button>
      </div>
    </main>
  );
}
