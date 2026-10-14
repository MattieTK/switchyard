import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ConnectionStatus } from "../../../src/server/routes/connect.ts";
import { api, authUrl } from "../api.ts";
import { go, useRoute } from "../router.ts";

type Refresh = () => Promise<void>;

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
    return (
      <main>
        <p className={error ? "error" : ""}>{error ?? "Checking your connections…"}</p>
      </main>
    );
  }
  const ready =
    status.vercel.connected && status.cloudflare.connected && Boolean(status.cloudflare.accountId) && status.github.connected;

  return (
    <main>
      <h1>Connect your accounts</h1>
      <p className="lede">
        Switchyard reads your projects from Vercel, deploys them to Cloudflare and opens pull requests on GitHub. Tokens are
        stored only on this machine.
      </p>
      {oauthError && <p className="error">Cloudflare login didn't complete: {oauthError}</p>}
      {error && <p className="error">{error}</p>}
      <VercelCard status={status.vercel} onChange={refresh} />
      <CloudflareCard status={status.cloudflare} onChange={refresh} />
      <GitHubCard status={status.github} onChange={refresh} />
      <button className="primary" disabled={!ready} onClick={() => go("#/projects")}>
        Continue to projects
      </button>
    </main>
  );
}

function VercelCard({ status, onChange }: { status: ConnectionStatus["vercel"]; onChange: Refresh }) {
  const [token, setToken] = useState("");
  const [warning, setWarning] = useState<string | null>(null);
  const { busy, error, run } = useAction(onChange);

  if (status.connected) {
    return (
      <section className="card">
        <h2>Vercel</h2>
        <p className="ok">
          Connected{status.username ? ` as ${status.username}` : ""} with a{" "}
          {status.scope === "team" ? "team-scoped" : "full-account"} token
          {status.teamName ? `, using the ${status.teamName} team` : ""}.
        </p>
        {warning && <p className="warning">{warning}</p>}
        {status.scope === "account" && status.teams.length > 0 && (
          <label>
            Show projects from{" "}
            <select
              value={status.teamId ?? ""}
              disabled={busy}
              onChange={(e) =>
                void run(() => api("/api/vercel/team", { method: "POST", body: { teamId: e.target.value || null } }))
              }
            >
              <option value="">Your personal account</option>
              {status.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <button disabled={busy} onClick={() => void run(() => api("/api/vercel", { method: "DELETE" }))}>
          Disconnect
        </button>
      </section>
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
    <section className="card">
      <h2>Vercel</h2>
      <h3>Create a Vercel token</h3>
      <ol>
        <li>
          Open{" "}
          <a href="https://vercel.com/account/tokens" target="_blank" rel="noreferrer">
            vercel.com/account/tokens
          </a>
          . Check that the switcher at the top left shows your <strong>personal account</strong>, not a team. Tokens are always
          created from your personal account, even when they're for a team.
        </li>
        <li>
          Name it something you'll recognise later, such as <code>cloudflare-migration</code>.
        </li>
        <li>
          Under <strong>Scope</strong>: if your projects belong to a <strong>team</strong>, select the team, then{" "}
          <strong>All Projects</strong>. If they're on your <strong>personal (Hobby)</strong> account, or spread over several
          teams, choose <strong>Full Account</strong>. Don't pick a single project – a project-scoped token can't list your
          projects or read team-level integrations, both of which Switchyard needs.
        </li>
        <li>
          Under <strong>Expiration</strong>, pick <strong>30 days</strong>. Migration runs in two stages (convert, then
          cut-over after the PR merges), so the token needs to last until you've done both. You can paste a new token at any
          point if it expires.
        </li>
        <li>
          Select <strong>Create</strong>, copy the token now (Vercel shows it only once), and paste it below.
        </li>
      </ol>
      <p className="lede">
        If your team requires two-factor authentication or SAML, Vercel will ask you to set that up before it lets you choose
        the team.
      </p>
      <p className="lede">
        <strong>What we use it for.</strong> We read project settings, env vars, domains, integrations and{" "}
        <code>vercel.json</code>. We write to Vercel only if you choose "Disconnect Vercel Git" during cut-over. The token is
        stored only on this machine.
      </p>
      <p className="lede">
        <strong>One limitation.</strong> No token can read values of env vars marked Sensitive in Vercel. We'll list those
        for you to enter by hand.
      </p>
      <form onSubmit={submit}>
        <label>
          Vercel token{" "}
          <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
        <button className="primary" disabled={busy || !token.trim()}>
          {busy ? "Checking…" : "Connect Vercel"}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function CloudflareCard({ status, onChange }: { status: ConnectionStatus["cloudflare"]; onChange: Refresh }) {
  const { busy, error, run } = useAction(onChange);

  if (!status.connected) {
    return (
      <section className="card">
        <h2>Cloudflare</h2>
        {status.error && <p className="warning">Your Cloudflare session has ended. Log in again.</p>}
        <p>
          You'll be asked to approve access to Workers, Workers Builds, KV, R2, D1, zones and DNS. Switchyard uses these to
          create the Worker, connect builds and, later, move your domains.
        </p>
        <a className="button primary" href={authUrl("/auth/cloudflare/start")}>
          Log in with Cloudflare
        </a>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Cloudflare</h2>
      <p className="ok">Logged in{status.email ? ` as ${status.email}` : ""}.</p>
      <label>
        Deploy to account{" "}
        <select
          value={status.accountId ?? ""}
          disabled={busy}
          onChange={(e) => void run(() => api("/api/cloudflare/account", { method: "POST", body: { accountId: e.target.value } }))}
        >
          <option value="" disabled>
            Choose an account
          </option>
          {status.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="error">{error}</p>}
      <button disabled={busy} onClick={() => void run(() => api("/api/cloudflare", { method: "DELETE" }))}>
        Disconnect
      </button>
    </section>
  );
}

function GitHubCard({ status, onChange }: { status: ConnectionStatus["github"]; onChange: Refresh }) {
  const [token, setToken] = useState("");
  const { busy, error, run } = useAction(onChange);

  if (status.connected) {
    return (
      <section className="card">
        <h2>GitHub</h2>
        <p className="ok">
          {status.source === "gh" ? `Using gh as ${status.login}.` : `Using a pasted token for ${status.login}.`}
        </p>
        {status.source === "pat" && (
          <button disabled={busy} onClick={() => void run(() => api("/api/github", { method: "DELETE" }))}>
            Remove token
          </button>
        )}
      </section>
    );
  }

  return (
    <section className="card">
      <h2>GitHub</h2>
      <p>
        Run <code>gh auth login</code> in a terminal, then select Check again. Or paste a fine-grained token with Contents and
        Pull requests read and write access on the repositories you'll migrate.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api("/api/github/pat", { method: "POST", body: { token } });
            setToken("");
          });
        }}
      >
        <label>
          GitHub token{" "}
          <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
        <button className="primary" disabled={busy || !token.trim()}>
          Save token
        </button>{" "}
        <button type="button" disabled={busy} onClick={() => void run(async () => {})}>
          Check again
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
