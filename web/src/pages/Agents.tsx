import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { useCallback, useEffect, useState } from "react";
import type { AgentPreferences } from "../../../src/agent/preferences.ts";
import { AGENT_LABELS, type AgentId, type AgentStatus } from "../../../src/agent/types.ts";
import type { AgentsResponse } from "../../../src/server/routes/agents.ts";
import { api } from "../api.ts";
import { Button, Callout, Card, Checkbox, Pill, SelectField, TextField } from "../ui/controls.tsx";

const NONE = "none";

export function useAgents() {
  const [data, setData] = useState<AgentsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setData(await api<AgentsResponse>("/api/agents"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { data, error, refresh };
}

function statusPill(a: AgentStatus) {
  if (a.signedIn) return <Pill tone="ok">Signed in</Pill>;
  return <Pill tone={a.installed ? "warn" : "neutral"}>{a.installed ? "Not signed in" : "Not installed"}</Pill>;
}

// The preferred agent, when it can run, or else the first that can.
export function defaultAgent(data: AgentsResponse): AgentId | null {
  const usable = data.agents.filter((a) => a.signedIn).map((a) => a.id);
  const preferred = data.preferences.preferred;
  return preferred && usable.includes(preferred) ? preferred : (usable[0] ?? null);
}

// On the Connect page: which agents can recover failed steps, and the user's choices for them.
export function AgentsCard() {
  const { data, error, refresh } = useAgents();
  const [draft, setDraft] = useState<AgentPreferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (data) setDraft(data.preferences);
  }, [data]);

  if (!data || !draft) return error ? <Callout tone="error">{error}</Callout> : null;

  const save = async () => {
    setBusy(true);
    setSaveError(null);
    try {
      await api("/api/agents/preferences", { method: "PUT", body: draft });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      await refresh();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Recovery agent (optional)">
      <p className="note">
        When a step still fails after Switchyard's own fixes, Switchyard can ask your own coding agent to fix the project, then
        run the step again. It uses Claude Code or Codex as installed on this machine, with your own sign-in, and never sees
        your credentials. You choose it for each migration on the plan screen.
      </p>
      <div className="stack">
        {data.agents.map((a) => (
          <div key={a.id} className="agent-row">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>{AGENT_LABELS[a.id]}</strong>
              {statusPill(a)}
            </div>
            <p className="muted small" style={{ margin: "0.25rem 0" }}>
              {a.detail}.{a.sandbox && ` ${a.sandbox.detail}`}
            </p>
            <TextField
              label={`${AGENT_LABELS[a.id]} model`}
              description="Leave empty to use the CLI's own default."
              placeholder="Default"
              list={`models-${a.id}`}
              value={draft.models[a.id] ?? ""}
              onValueChange={(v) => setDraft({ ...draft, models: { ...draft.models, [a.id]: v.trim() } })}
            />
            <datalist id={`models-${a.id}`}>
              {data.suggestions[a.id].map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
        ))}
        <SelectField
          label="Preferred agent"
          value={draft.preferred ?? NONE}
          options={[
            { value: NONE, label: "No preference" },
            ...data.agents.map((a) => ({ value: a.id, label: AGENT_LABELS[a.id], disabled: !a.signedIn && a.id !== draft.preferred })),
          ]}
          onChange={(v) => setDraft({ ...draft, preferred: v === NONE ? null : (v as AgentId) })}
        />
        {saveError && <Callout tone="error">{saveError}</Callout>}
        <div className="row">
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            {saved ? "Saved" : "Save"}
          </Button>
          <Button disabled={busy} onClick={() => void refresh()}>
            Check again
          </Button>
        </div>
      </div>
    </Card>
  );
}

// On the plan screen: whether to ask an agent when a step still fails, and which.
export function RecoveryCard({
  data,
  agent,
  onChange,
}: {
  data: AgentsResponse | null;
  agent: AgentId | null;
  onChange: (agent: AgentId | null) => void;
}) {
  if (!data) return null;
  const usable = data.agents.filter((a) => a.signedIn);
  const fallback = defaultAgent(data);
  return (
    <Card title="Recovery">
      {usable.length === 0 ? (
        <p className="note">
          Switchyard can ask Claude Code or Codex to fix a step that still fails. Sign in to one of them, then set it up on the{" "}
          <a href="#/connect">Connect page</a>.
        </p>
      ) : (
        <>
          <Checkbox
            checked={agent !== null}
            onChange={(c) => onChange(c ? fallback : null)}
            label="If a step still fails, ask an agent to fix it"
          />
          <p className="note">
            Switchyard sends the agent what it has done and the redacted error output, never your environment values. Its changes
            go into the pull request, listed for review.
          </p>
          {agent !== null && usable.length > 1 && (
            <RadioGroup className="radio-group" aria-label="Agent" value={agent} onValueChange={(v) => onChange(v as AgentId)}>
              {usable.map((a) => (
                <label key={a.id} className="radio-option">
                  <Radio.Root value={a.id} className="radio">
                    <Radio.Indicator className="radio-indicator" />
                  </Radio.Root>
                  <span>
                    <strong>{AGENT_LABELS[a.id]}</strong>
                    {data.preferences.preferred === a.id && <span className="muted"> (preferred)</span>}
                    <br />
                    <span className="muted">
                      {a.detail}
                      {data.preferences.models[a.id] ? `, model ${data.preferences.models[a.id]}` : ""}.{a.sandbox && ` ${a.sandbox.detail}`}
                    </span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          )}
          {agent !== null && usable.length === 1 && usable[0] && (
            <p className="note">
              {AGENT_LABELS[usable[0].id]}: {usable[0].detail}.{usable[0].sandbox && ` ${usable[0].sandbox.detail}`}
            </p>
          )}
        </>
      )}
    </Card>
  );
}
