import { Collapsible } from "@base-ui/react/collapsible";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { ConnectionStatus } from "../../../src/server/routes/connect.ts";
import { api, authUrl } from "../api.ts";
import { go, useRoute } from "../router.ts";
import { Button, ButtonLink, Callout, Card, Loading, Pill, SelectField, TextField } from "../ui/controls.tsx";
import { ArrowIcon, ChevronIcon, ExternalIcon } from "../ui/icons.tsx";

type Refresh = () => Promise<void>;

// Base UI selects need a non-empty value, so the personal account gets a stand-in.
const PERSONAL = "personal";

function useAction(onDone: Refresh) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function Service({
  logo,
  name,
  connected,
  summary,
  children,
}: {
  logo: string;
  name: string;
  connected: boolean;
  summary?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card>
      <div className="service">
        <span className="service-logo" aria-hidden>
          {logo}
        </span>
        <div className="service-main">
          <div className="service-head">
            <div>
              <h2>{name}</h2>
              {summary && <p className="service-status">{summary}</p>}
            </div>
            <Pill tone={connected ? "ok" : "neutral"}>{connected ? "Connected" : "Not connected"}</Pill>
          </div>
          {children && <div style={{ marginTop: "0.75rem" }}>{children}</div>}
        </div>
      </div>
    </Card>
  );
}

export function Connect() {
  const route = useRoute();
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setStatus(await api<ConnectionStatus>("/api/status"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const oauthError = route.query.get("error");
  if (!status) {
    return <main>{error ? <Callout tone="error">{error}</Callout> : <Loading>Checking your connections…</Loading>}</main>;
  }
  const cf = status.cloudflare;
  const cloudflareReady = cf.connected && cf.accounts.some((a) => a.id === cf.accountId && a.canDeployWorkers);
  const ready = status.vercel.connected && cloudflareReady && status.github.connected;

  return (
    <main>
      <div className="page-head">
        <h1>Connect your accounts</h1>
        <p className="lede">
          Switchyard reads your projects from Vercel, deploys them to Cloudflare and opens pull requests on GitHub. Tokens are
          stored only on this machine.
        </p>
      </div>
      <div className="stack">
        {oauthError && <Callout tone="error">Cloudflare login didn't complete: {oauthError}</Callout>}
        {error && <Callout tone="error">{error}</Callout>}
        <VercelCard status={status.vercel} onChange={refresh} />
        <CloudflareCard status={status.cloudflare} onChange={refresh} />
        <GitHubCard status={status.github} onChange={refresh} />
      </div>
      <div className="action-bar">
        <p className="note">{ready ? "All three accounts are connected." : "Connect all three accounts to continue."}</p>
        <Button variant="primary" disabled={!ready} onClick={() => go("#/projects")}>
          Continue to projects <ArrowIcon />
        </Button>
      </div>
    </main>
  );
}

function VercelCard({ status, onChange }: { status: ConnectionStatus["vercel"]; onChange: Refresh }) {
  const [token, setToken] = useState("");
  const [warning, setWarning] = useState<string | null>(null);
  const { busy, error, run } = useAction(onChange);

  if (status.connected) {
    return (
      <Service
        logo="V"
        name="Vercel"
        connected
        summary={
          <>
            Connected{status.username ? ` as ${status.username}` : ""} with a{" "}
            {status.scope === "team" ? "team-scoped" : "full-account"} token
            {status.teamName ? `, using the ${status.teamName} team` : ""}.
          </>
        }
      >
        {warning && <Callout tone="warning">{warning}</Callout>}
        {status.scope === "account" && status.teams.length > 0 && (
          <SelectField
            label="Show projects from"
            value={status.teamId ?? PERSONAL}
            disabled={busy}
            options={[
              { value: PERSONAL, label: "Your personal account" },
              ...status.teams.map((t) => ({ value: t.id, label: t.name })),
            ]}
            onChange={(v) =>
              void run(() => api("/api/vercel/team", { method: "POST", body: { teamId: v === PERSONAL ? null : v } }))
            }
          />
        )}
        {error && <Callout tone="error">{error}</Callout>}
        <Button disabled={busy} onClick={() => void run(() => api("/api/vercel", { method: "DELETE" }))}>
          Disconnect
        </Button>
      </Service>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api<{ warning?: string }>("/api/vercel/token", { method: "POST", body: { token } });
      setWarning(r.warning ?? null);
      setToken("");
    });
  };

  return (
    <Service logo="V" name="Vercel" connected={false} summary="Paste a Vercel token so Switchyard can read your projects.">
      <Collapsible.Root defaultOpen>
        <Collapsible.Trigger className="collapsible-trigger">
          Create a Vercel token
          <ChevronIcon />
        </Collapsible.Trigger>
        <Collapsible.Panel className="collapsible-panel">
          <ol className="steps-list">
            <li>
              Open{" "}
              <a href="https://vercel.com/account/tokens" target="_blank" rel="noreferrer">
                vercel.com/account/tokens <ExternalIcon />
              </a>
              . Check that the switcher at the top left shows your <strong>personal account</strong>, not a team. Tokens are
              always created from your personal account, even when they're for a team.
            </li>
            <li>
              Name it something you'll recognise later, such as <code>cloudflare-migration</code>.
            </li>
            <li>
              Under <strong>Scope</strong>: if your projects belong to a <strong>team</strong>, select the team, then{" "}
              <strong>All Projects</strong>. If they're on your <strong>personal (Hobby)</strong> account, or spread over
              several teams, choose <strong>Full Account</strong>. Don't pick a single project – a project-scoped token can't
              list your projects or read team-level integrations, both of which Switchyard needs.
            </li>
            <li>
              Under <strong>Expiration</strong>, pick <strong>30 days</strong>. Migration runs in two stages (convert, then
              cut-over after the PR merges), so the token needs to last until you've done both. You can paste a new token at
              any point if it expires.
            </li>
            <li>
              Select <strong>Create</strong>, copy the token now (Vercel shows it only once), and paste it below.
            </li>
          </ol>
          <p className="note">
            If your team requires two-factor authentication or SAML, Vercel will ask you to set that up before it lets you
            choose the team.
          </p>
          <p className="note">
            <strong>What we use it for.</strong> We read project settings, env vars, domains, integrations and{" "}
            <code>vercel.json</code>. We write to Vercel only if you choose "Disconnect Vercel Git" during cut-over. The token
            is stored only on this machine.
          </p>
          <p className="note">
            <strong>One limitation.</strong> No token can read values of env vars marked Sensitive in Vercel. We'll list those
            for you to enter by hand.
          </p>
        </Collapsible.Panel>
      </Collapsible.Root>
      <form onSubmit={submit} className="form-row" style={{ marginTop: "1rem" }}>
        <TextField label="Vercel token" type="password" autoComplete="off" value={token} onValueChange={setToken} />
        <Button type="submit" variant="primary" busy={busy} disabled={!token.trim()}>
          {busy ? "Checking…" : "Connect Vercel"}
        </Button>
      </form>
      {error && (
        <div style={{ marginTop: "0.75rem" }}>
          <Callout tone="error">{error}</Callout>
        </div>
      )}
    </Service>
  );
}

function CloudflareCard({ status, onChange }: { status: ConnectionStatus["cloudflare"]; onChange: Refresh }) {
  const { busy, error, run } = useAction(onChange);

  if (!status.connected) {
    return (
      <Service
        logo="CF"
        name="Cloudflare"
        connected={false}
        summary="You'll be asked to approve access to Workers, Workers Builds, KV, R2, D1, zones and DNS. Switchyard uses these to create the Worker, connect builds and, later, move your domains."
      >
        {status.error && <Callout tone="warning">Your Cloudflare session has ended. Log in again.</Callout>}
        <div style={{ marginTop: "0.75rem" }}>
          <ButtonLink variant="primary" href={authUrl("/auth/cloudflare/start")}>
            Log in with Cloudflare <ArrowIcon />
          </ButtonLink>
        </div>
      </Service>
    );
  }

  const selected = status.accounts.find((a) => a.id === status.accountId);
  return (
    <Service logo="CF" name="Cloudflare" connected summary={`Logged in${status.email ? ` as ${status.email}` : ""}.`}>
      <SelectField
        label="Deploy to account"
        value={status.accountId ?? null}
        placeholder="Choose an account"
        disabled={busy}
        options={status.accounts.map((a) => ({
          value: a.id,
          label: a.canDeployWorkers ? a.name : `${a.name} (read-only for Workers)`,
          // The current choice stays selectable so the select can still show it.
          disabled: !a.canDeployWorkers && a.id !== status.accountId,
        }))}
        onChange={(v) => void run(() => api("/api/cloudflare/account", { method: "POST", body: { accountId: v } }))}
      />
      {selected && !selected.canDeployWorkers && (
        <Callout tone="warning">
          You can only read Workers on {selected.name}, so Switchyard can't deploy there. Choose another account, or ask an
          administrator of {selected.name} for a role that can edit Workers.
        </Callout>
      )}
      {error && <Callout tone="error">{error}</Callout>}
      <Button disabled={busy} onClick={() => void run(() => api("/api/cloudflare", { method: "DELETE" }))}>
        Disconnect
      </Button>
    </Service>
  );
}

function GitHubCard({ status, onChange }: { status: ConnectionStatus["github"]; onChange: Refresh }) {
  const [token, setToken] = useState("");
  const { busy, error, run } = useAction(onChange);

  if (status.connected) {
    return (
      <Service
        logo="GH"
        name="GitHub"
        connected
        summary={status.source === "gh" ? `Using gh as ${status.login}.` : `Using a pasted token for ${status.login}.`}
      >
        {status.source === "pat" && (
          <Button disabled={busy} onClick={() => void run(() => api("/api/github", { method: "DELETE" }))}>
            Remove token
          </Button>
        )}
      </Service>
    );
  }

  return (
    <Service
      logo="GH"
      name="GitHub"
      connected={false}
      summary={
        <>
          Run <code>gh auth login</code> in a terminal, then select Check again. Or paste a fine-grained token with Contents
          and Pull requests read and write access on the repositories you'll migrate.
        </>
      }
    >
      <form
        className="form-row"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api("/api/github/pat", { method: "POST", body: { token } });
            setToken("");
          });
        }}
      >
        <TextField label="GitHub token" type="password" autoComplete="off" value={token} onValueChange={setToken} />
        <Button type="submit" variant="primary" busy={busy} disabled={!token.trim()}>
          Save token
        </Button>
        <Button type="button" disabled={busy} onClick={() => void run(async () => {})}>
          Check again
        </Button>
      </form>
      {error && (
        <div style={{ marginTop: "0.75rem" }}>
          <Callout tone="error">{error}</Callout>
        </div>
      )}
    </Service>
  );
}
