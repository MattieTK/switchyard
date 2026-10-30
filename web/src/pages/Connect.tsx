import { Collapsible } from "@base-ui/react/collapsible";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { ConnectionStatus } from "../../../src/server/routes/connect.ts";
import { api, authUrl } from "../api.ts";
import { go, useRoute } from "../router.ts";
import { Button, ButtonLink, Callout, Card, Loading, Pill, SelectField, TextField } from "../ui/controls.tsx";
import { ArrowIcon, ChevronIcon, CopyIcon, ExternalIcon } from "../ui/icons.tsx";

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
  // A migration whose failed step sent the user here to sign in with ChatGPT.
  const returnTo = route.query.get("return")?.match(/^[0-9a-f-]{36}$/)?.[0];

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

      <div className="section-head" id="openai">
        <h2>Optional: fix failed builds with AI</h2>
        <p className="note">
          Sign in with ChatGPT and, when a build or deploy fails, a model can fix the code and try again. You can skip this,
          and sign in later from a failed migration.
        </p>
      </div>
      {returnTo && (
        <Callout tone={status.openai.connected ? "success" : "info"}>
          <p style={{ margin: 0 }}>
            {status.openai.connected
              ? "You're signed in. Go back to the migration and select Fix with AI."
              : "Sign in with ChatGPT below, then go back to the migration and select Fix with AI."}
          </p>
          <div className="row" style={{ marginTop: "0.6rem" }}>
            <Button variant={status.openai.connected ? "primary" : "secondary"} onClick={() => go(`#/jobs/${returnTo}`)}>
              Back to the migration <ArrowIcon />
            </Button>
          </div>
        </Callout>
      )}
      <div className="stack">
        <OpenAICard status={status.openai} onChange={refresh} />
      </div>

      <div className="action-bar">
        <p className="note">
          {!ready
            ? "Connect Vercel, Cloudflare and GitHub to continue."
            : status.openai.connected
              ? "All set, including AI fixes."
              : "Vercel, Cloudflare and GitHub are connected. Signing in with ChatGPT is optional."}
        </p>
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

// The code a ChatGPT sign-in is waiting for, and how often to ask whether it was entered.
interface DeviceSignIn {
  userCode: string;
  verificationUrl: string;
  interval: number;
}

function OpenAICard({ status, onChange }: { status: ConnectionStatus["openai"]; onChange: Refresh }) {
  const [apiKey, setApiKey] = useState("");
  const [device, setDevice] = useState<DeviceSignIn | null>(null);
  const [copied, setCopied] = useState(false);
  const { busy, error, run } = useAction(onChange);
  const [signInError, setSignInError] = useState<string | null>(null);

  // Asks Switchyard every few seconds whether the code was entered, until it was or failed.
  useEffect(() => {
    if (!device) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await api<{ status: "pending" | "connected" }>("/api/openai/device/poll", { method: "POST" });
        if (stopped) return;
        if (r.status === "connected") {
          setDevice(null);
          await onChange();
          return;
        }
        timer = setTimeout(() => void poll(), device.interval * 1000);
      } catch (e) {
        if (stopped) return;
        setDevice(null);
        setSignInError((e as Error).message);
      }
    };
    timer = setTimeout(() => void poll(), device.interval * 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [device, onChange]);

  if (status.connected) {
    const who =
      status.via === "chatgpt"
        ? `Signed in with ChatGPT${status.email ? ` as ${status.email}` : ""}${status.plan ? ` (${status.plan})` : ""}.`
        : "Connected with an API key.";
    return (
      <Service
        logo="AI"
        name="OpenAI"
        connected
        summary={`${who} When a build or deploy fails, the plan can let this model fix the code and try again.`}
      >
        <SelectField
          label="Model"
          value={status.model}
          disabled={busy}
          options={status.models.map((m) => ({ value: m, label: m }))}
          onChange={(model) => void run(() => api("/api/openai/model", { method: "POST", body: { model } }))}
        />
        {error && <Callout tone="error">{error}</Callout>}
        <Button disabled={busy} onClick={() => void run(() => api("/api/openai", { method: "DELETE" }))}>
          {status.via === "chatgpt" ? "Sign out" : "Disconnect"}
        </Button>
      </Service>
    );
  }

  const startSignIn = () =>
    void run(async () => {
      setSignInError(null);
      setDevice(await api<DeviceSignIn>("/api/openai/device", { method: "POST" }));
    });

  return (
    <Service
      logo="AI"
      name="OpenAI"
      connected={false}
      summary={
        <>
          When a build or deploy fails, an OpenAI model can fix the code and try again. Its changes go on the migration
          branch and are listed in the pull request for you to review.
        </>
      }
    >
      {status.error && <Callout tone="warning">Your OpenAI sign-in has ended. Sign in again.</Callout>}
      {(signInError ?? error) && <Callout tone="error">{signInError ?? error}</Callout>}

      {device ? (
        <div className="device-signin">
          <ol className="steps-list">
            <li>
              Open{" "}
              <a href={device.verificationUrl} target="_blank" rel="noreferrer">
                {device.verificationUrl.replace(/^https:\/\//, "")} <ExternalIcon />
              </a>{" "}
              and sign in to ChatGPT.
            </li>
            <li>
              Enter this code. It expires in 15 minutes.
              <div className="row" style={{ marginTop: "0.5rem" }}>
                <code className="device-code">{device.userCode}</code>
                <Button
                  variant="ghost"
                  onClick={() =>
                    void navigator.clipboard.writeText(device.userCode).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    })
                  }
                >
                  <CopyIcon /> {copied ? "Copied" : "Copy code"}
                </Button>
              </div>
            </li>
          </ol>
          <div className="row">
            <Loading>Waiting for you to enter the code…</Loading>
            <Button variant="ghost" onClick={() => setDevice(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="note">
            Sign in with your ChatGPT account, as the Codex CLI does. Fixes count towards your plan's Codex usage limits, so
            it needs a plan that includes Codex.
          </p>
          <Button variant="primary" busy={busy} onClick={startSignIn}>
            Sign in with ChatGPT <ArrowIcon />
          </Button>
        </>
      )}

      <p className="note" style={{ marginTop: "1rem" }}>
        <strong>What we send.</strong> Only when you choose this on the plan and a step fails: the error output and the project
        files the model asks to read. Secret values are hidden first, and <code>.env</code> and <code>.dev.vars</code> files
        are never sent.
      </p>

      <Collapsible.Root>
        <Collapsible.Trigger className="collapsible-trigger">
          Use an API key instead
          <ChevronIcon />
        </Collapsible.Trigger>
        <Collapsible.Panel className="collapsible-panel">
          <p className="note">
            Usage is billed to the key's OpenAI organisation instead of your ChatGPT plan. Create a key at{" "}
            <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">
              platform.openai.com/api-keys <ExternalIcon />
            </a>{" "}
            in a project with access to the models you want. Leave permissions on <strong>All</strong>, or if you restrict them,
            allow listing models and creating responses.
          </p>
          <form
            className="form-row"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api("/api/openai/key", { method: "POST", body: { apiKey } });
                setApiKey("");
              });
            }}
          >
            <TextField label="OpenAI API key" type="password" autoComplete="off" value={apiKey} onValueChange={setApiKey} />
            <Button type="submit" busy={busy} disabled={!apiKey.trim()}>
              {busy ? "Checking…" : "Connect with a key"}
            </Button>
          </form>
        </Collapsible.Panel>
      </Collapsible.Root>
    </Service>
  );
}
