# Switchyard – design

Date: 2026-10-14
Status: draft for review

## Purpose

Switchyard is a local tool that moves projects from Vercel to Cloudflare. You connect a Vercel account with an API token, a Cloudflare account with OAuth and GitHub with your existing `gh` login. Then you pick Vercel projects, review a migration plan and let Switchyard convert, deploy and connect each project to Cloudflare Workers Builds, so that later pushes deploy to Cloudflare rather than Vercel.

It takes inspiration from [diverce](https://github.com/ygwyg/diverce), but shares no code with it. Diverce converts Next.js projects with OpenNext and leaves deployment to you. Switchyard:

- uses `cf`, the new Cloudflare CLI, and `cloudflare.config.ts` as the basis for every project;
- uses vinext to convert Next.js apps;
- copies env vars and secrets;
- sets up git-connected builds;
- handles domains, `vercel.json` config and storage.

### Success criteria

- A supported Vercel project ends up as a Cloudflare Worker, built by Workers Builds from its GitHub repo, with its env vars and secrets in place.
- The migration lands as a PR, and Vercel keeps serving production until you merge it and run the cut-over.
- Anything Switchyard can't move automatically, such as Sensitive env vars, unsupported features, storage code or domains outside your Cloudflare account, is listed for you to handle, in the plan before anything runs and again in the PR.
- No secret value appears in logs, job files or the UI after you enter it.

## Decisions

| Topic | Decision |
| --- | --- |
| Vercel auth | Pasted API token (no Vercel OAuth) |
| Cloudflare auth | OAuth Authorization Code + PKCE with a public client created on the maintainer's account |
| GitHub auth | Existing `gh` login first, pasted PAT as fallback |
| After migration | Git-connected Workers Builds |
| Code delivery | Push a `cloudflare-migration` branch and open a PR |
| Frameworks | Next.js (vinext) plus any Vite-based framework through `cf` and the Cloudflare Vite plugin, and static sites |
| Extras | Custom domains, `vercel.json` (crons, redirects, rewrites, headers), storage detection with an optional move to R2/KV/D1 |
| Architecture | Node + Hono server, React SPA built with Vite, pipeline module that runs `git`, `gh`, `vinext` and `cf` as child processes |
| Location | New repo at `~/GitHub/switchyard` |

## Architecture

Switchyard is a single Node package containing a local server and an SPA.

```
src/
  server/        Hono app on 127.0.0.1 only; serves the SPA and /api; SSE for job progress
  auth/
    store.ts               credentials in ~/.config/switchyard/credentials.json (mode 0600)
    cloudflare-oauth.ts    Authorization Code + PKCE, localhost callback, token refresh
    github.ts              `gh auth token` first, pasted PAT as fallback
  clients/       typed fetch wrappers; fetch is injected so tests can mock it
    vercel.ts        user and teams, projects, env (decrypt), domains, integrations
    cloudflare.ts    accounts, zones, worker secrets, Builds (repo connections, tokens,
                     triggers, trigger env vars), custom domains
    github.ts        repo IDs, file reads, PR creation
  adapters/      one per framework: detect() + convert()
  translate/     pure functions: vercel.json → Cloudflare config, env vars → env plan,
                 storage detection → recommendations
  pipeline/      ordered, resumable steps; job state in ~/.config/switchyard/jobs/
  redact.ts      registry of secret values, replaced with *** in all output
web/             React SPA (Vite)
```

Every unit has one job and can be tested on its own:

- `translate/` holds only pure functions.
- `clients/` holds only HTTP calls.
- `adapters/` holds only the per-framework conversion, called through a command-runner interface.
- `pipeline/` puts the other units together.

Working copies live in `~/.cache/switchyard/work/<project>`.

### Local server security

The server holds live credentials, so it has to resist requests from other web pages in the browser:

- It binds to `127.0.0.1` only.
- It rejects any request whose `Host` header is not `localhost:<port>` or `127.0.0.1:<port>`, which blocks DNS rebinding.
- Each launch generates a random token. The server puts it in the URL it opens and requires it on every `/api` request.

### Cloudflare OAuth client

A public OAuth client is created on the maintainer's Cloudflare account through the `oauth_clients` API:

- **Grant type and token auth:** Authorization Code, token auth method `none`, PKCE with S256.
- **Redirect:** `http://localhost:<port>/auth/cloudflare/callback`.
- **Scopes:** kept to what the pipeline uses – account and user read, Workers Scripts edit, Workers Builds Configuration edit, the KV, R2 and D1 edit permissions needed to provision bindings, Zone read, and Workers routes and custom domains edit.

Because the client is public, Switchyard ships only its client ID and no secret.

## Connect screen

There are three cards, one per service. Each shows who you're connected as and has a disconnect button.

### Vercel

The card shows this guide:

> **Create a Vercel token**
>
> 1. Open [vercel.com/account/tokens](https://vercel.com/account/tokens). Check that the switcher at the top left shows your **personal account**, not a team. Tokens are always created from your personal account, even when they're for a team.
> 2. Name it something you'll recognise later, such as `cloudflare-migration`.
> 3. Under **Scope**:
>    - If your projects belong to a **team**, select the team, then **All Projects**.
>    - If they're on your **personal (Hobby)** account, or spread over several teams, choose **Full Account**.
>    - Don't pick a single project. A project-scoped token can't list your projects or read team-level integrations, both of which this tool needs.
> 4. Under **Expiration**, pick **30 days**. Migration runs in two stages (convert, then cut-over after the PR merges), so the token needs to last until you've done both. You can paste a new token at any point if it expires.
> 5. Select **Create**, copy the token now (Vercel shows it only once), and paste it below.
>
> If your team requires two-factor authentication or SAML, Vercel will ask you to set that up before it lets you choose the team.
>
> **What we use it for.** We read project settings, env vars, domains, integrations and `vercel.json`. We write to Vercel only if you choose "Disconnect Vercel Git" during cut-over. The token is stored only on this machine.
>
> **One limitation.** No token can read values of env vars marked Sensitive in Vercel. We'll list those for you to enter by hand.

When you paste a token, the server does the following:

1. **Format check.** If the token doesn't start with `vcp_`, the card shows a soft warning, since older tokens may still be valid.
2. **Finding out what the token can reach.** The server calls `GET /v2/user`, `GET /v2/teams` and `GET /v9/projects` and records which calls succeed. It accepts whatever succeeds rather than assuming a fixed pattern, because Vercel doesn't document exactly what each scope can reach.
   - If the token covers the whole account and you belong to teams, the card shows a team picker.
   - If it covers one team, no picker is shown; Vercel infers the team from the token.
   - If it covers a single project, the card explains that the token needs a wider scope.
3. **A check on env var access.** When the first plan is built, the server reads one project's env vars with `decrypt=true`. If values come back missing for a reason other than being Sensitive, the plan shows a warning before you approve anything.

### Cloudflare

The card has an OAuth button. If you have more than one Cloudflare account, it then shows an account picker. Expired access tokens are refreshed automatically.

### GitHub

The card shows "using gh as `<login>`" when `gh auth token` works. Otherwise it shows a field for a fine-grained PAT with Contents and Pull requests read/write access on the target repos.

## Migration flow

A migration has three phases, and each phase ends at a point where you decide whether to continue.

### Phase 1 – Plan

This phase is read-only. Nothing changes on any service.

1. **Read the Vercel project.** This covers the framework, linked repo, root directory, production branch, build and install commands, Node version, env vars for every target, domains and integrations. `vercel.json` is read through the GitHub API, so nothing is cloned yet.
2. **Build the plan and show it**, in these sections:
   - **Adapter.** Which adapter will handle the project, and its status: supported, partial, or unsupported with the reason.
   - **Env vars.** Where each variable will go, as described under [Env var mapping](#env-var-mapping). Variables marked Sensitive in Vercel get an input field.
   - **`vercel.json`.** What happens to each cron, redirect, rewrite and header.
   - **Vercel-only features.** Features detected from dependencies and code that won't be converted, such as Edge Config, `@vercel/og`, Analytics and Speed Insights.
   - **Storage.** What was detected, with a suggestion for each and the choice between "report only" and "move to R2/KV/D1".
   - **Domains.** Which domains are on a zone in the connected Cloudflare account.
   - **Worker name.** Defaults to the Vercel project name.
3. You fill in the missing values and select **Approve and run**.

### Phase 2 – Convert and connect

This phase writes to GitHub and Cloudflare. Vercel production is not touched.

4. **Clone** the repo into the working directory and create the `cloudflare-migration` branch.
5. **Convert** using the adapter:
   - For Next.js, run `vinext init --platform=cloudflare`. Other frameworks use their own adapter's conversion.
   - Write `cloudflare.config.ts`.
   - Apply the `vercel.json` translations:
     - Each cron becomes a `triggers.scheduled` entry, plus a scheduled handler that calls the original route.
     - Redirects and headers become `_redirects` and `_headers`, unless the framework already handles them.
   - If you chose to move storage, add the matching binding (`bindings.r2()`, `kv()` or `d1()`) and write `CLOUDFLARE_MIGRATION.md`, described under [Storage moves](#storage-moves).
6. **Build locally** with `cf build`, which needs no Cloudflare login. If the build fails, the job stops with the full log and keeps the working copy. Nothing has been pushed yet.
7. **Create the Worker** with a first `cf deploy`. This gives a `workers.dev` URL, provisions bindings (including the vinext KV cache) and produces the `external_script_id` that Builds needs.
8. **Set runtime secrets** on the Worker through the API.
9. **Push the branch and open a PR.** The PR body links to the `workers.dev` deploy and contains a checklist of manual steps (Sensitive values entered elsewhere, storage code changes, the preview-secrets difference, unconverted features).
10. **Connect Workers Builds:**
    1. Check that the Cloudflare GitHub App can see the repo. If not, pause and show the install link with a **Check again** button.
    2. Create the repo connection.
    3. Look up the build token. If none exists, pause with instructions.
    4. Create a **production trigger** on the Vercel production branch, with the deploy command `npx cf deploy` and `root_directory` set to Vercel's `rootDirectory`.
    5. Create a **preview trigger** for all other branches.
    6. Set build variables on each trigger.
11. **Start a build** of `cloudflare-migration` and stream its status into the job log.

At the end of phase 2, Vercel still serves production and Cloudflare builds every push to the migration branch.

### Phase 3 – Cut-over

This phase is available only once the PR has merged and a production build on Cloudflare has succeeded.

- **Domains on a zone in your Cloudflare account** are attached as Workers Custom Domains. Before anything changes, the UI shows any existing DNS records that would be replaced, and each domain needs its own confirmation.
- **Domains on other zones** get DNS instructions instead.
- **Disconnect Vercel Git** is optional and needs its own confirmation. It is the only write Switchyard ever makes to Vercel.

### Env var mapping

Vercel has one set of env vars per target (production, preview, development), and they are available both at build time and at runtime. Cloudflare keeps build-time variables (on Workers Builds triggers) separate from runtime values (on the Worker).

| Vercel target | Build variables | Runtime |
| --- | --- | --- |
| Production | Production trigger (secret where Vercel's type is encrypted or Sensitive) | Worker secrets |
| Preview | Preview trigger (same secret rule) | Not set separately; see below |
| Development | Not uploaded | Written to a local `.dev.vars` file that is git-ignored and never committed |

Every runtime value is stored as a Worker secret, including values that are not secret on Vercel. There are two reasons:

- Non-secret values are never committed in `cloudflare.config.ts`.
- Secrets survive later `cf deploy` runs, whereas plain vars that aren't declared in the config may be removed.

Preview versions of a Worker share its runtime secrets, so at runtime preview deploys see production values. Separate preview runtime values are out of scope for now. The PR lists this difference.

### Storage moves

The plan detects Vercel storage from env var names, dependencies and integrations: Vercel Blob, KV and Postgres, and Marketplace providers such as Neon and Upstash.

- Marketplace storage is an external service, so the copied credentials keep working from Workers. It is reported only.
- For Vercel Blob, and for stores with a clear Cloudflare equivalent (KV and D1), the plan offers "move to R2/KV/D1". Choosing it does two things:
  - It adds the binding to `cloudflare.config.ts`. `cf deploy` then provisions the resource.
  - It writes `CLOUDFLARE_MIGRATION.md`, which serves as the agent instruction file. It names the binding, lists every file that imports `@vercel/blob`, `@vercel/kv` or a similar package, explains how to replace those calls with `env.<BINDING>` from `cloudflare:workers`, and explains how to copy existing objects across.

Switchyard doesn't rewrite the storage code or copy the data. That work is left to the user or a coding agent, using `CLOUDFLARE_MIGRATION.md`.

## UI

1. **Connect** – the three cards described above.
2. **Projects** – a table of Vercel projects showing framework, repo, production branch and a support badge, with the reason on hover. You can select several projects, but they run one after another as separate jobs.
3. **Plan review** – one page per project, as described in phase 1.
4. **Job** – the steps with their statuses, a live log for the current step, and each step's outputs (PR link, `workers.dev` URL, build link) once they exist. A failed step gets **Retry** and **Open working copy** buttons.
5. **Cut-over** – part of the job page, shown once the conditions for phase 3 are met.

## Error handling

| Kind | Behaviour |
| --- | --- |
| Credential errors (expired or revoked token, `gh` logged out) | Cloudflare tokens are refreshed first. If refreshing fails, or for Vercel and GitHub, the job **pauses** and the UI sends you to the Connect card. The job resumes after you reconnect. |
| Missing prerequisites (GitHub App not installed, no build token, domain zone not on the account) | The job pauses with a specific instruction and a **Check again** button. |
| Command failures (`vinext init`, `cf build`, `cf deploy`) | The step fails with the full output, and the working copy is kept. |
| API errors | Shown with the service's original error message. 429 and 5xx responses are retried up to three times with backoff. Other 4xx responses fail straight away. |

Each step saves its outputs (Worker ID, trigger IDs, PR URL) in the job state. A retry continues from the failed step without repeating earlier ones. A step that runs twice checks for what it would create (for example, whether the trigger already exists) before creating it.

The only force-push Switchyard ever makes is to `cloudflare-migration`.

All values from the env plan, plus every OAuth and API token, are registered with the redactor. The redactor replaces them with `***` in logs, the SSE stream and saved job files.

## Testing

Switchyard uses vitest, with these layers:

- **Pure units.** Env-plan building, `vercel.json` translation, storage detection, token-scope inference, the redactor, and `cloudflare.config.ts` generation (snapshot tests).
- **API clients.** Run with an injected `fetch` and recorded response fixtures, covering success, 4xx, 429 retry and 5xx backoff.
- **Pipeline.** Run with fake clients and a fake command runner. Covers retry from a failed step, pausing on a missing prerequisite, and steps that run twice.
- **Server.** Rejecting a bad `Host` header, rejecting a missing launch token, and SSE delivery.
- **Adapter fixtures.** A separate, slower command. One minimal sample app per framework, plus one monorepo, each converted for real and built with `cf build`. These need no Cloudflare login. An adapter shows as "supported" in the UI only once its fixture passes. Until then it shows as "partial".
- **End-to-end by hand.** One run on a throwaway Vercel project, through to cut-over on a test domain. Each external action is confirmed first.

## Spikes before building

The implementation plan starts with these checks, because each one can change part of the design:

| # | Question | Fallback if the answer is no |
| --- | --- | --- |
| 1 | Does `cf deploy` accept an OAuth access token in `CLOUDFLARE_API_TOKEN`? | Create the Worker and provision bindings through the API |
| 2 | Does `npx cf deploy` run inside Workers Builds with the injected build token? What is the `cf` equivalent of a preview deploy? | Use a wrangler-based deploy command in the triggers, with `cf` used locally only |
| 3 | Do Worker secrets set through the API survive a later `cf deploy`? | Upload secrets with `cf deploy --secrets-file` in step 7 and use build-variable secrets in Builds |
| 4 | Which endpoints can a team-scoped Vercel token reach, and how does `decrypt=true` behave on a real project? | Adjust the scope inference and the Connect guide |
| 5 | Does a Cloudflare OAuth token with Workers Builds Configuration scope pass the Builds API's "user-scoped token" check? | Ask for a user-scoped API token on the Cloudflare card for the Builds steps |
| 6 | Can a vinext Worker take a custom scheduled handler? | Generate a wrapper entry module that delegates `fetch` to vinext and adds `scheduled` |

## Risks and assumptions

- **`cf` is in beta and vinext is experimental.** Their commands and output may change. To contain this, Switchyard pins the versions it installs into converted projects, and only the adapters and the `cf` wrapper call these tools.
- **Supporting every Vite-based framework widens the work.** Next.js comes first, and each other adapter is a separate task. Astro 6 is currently reported not to build with `cf`, so it starts as unsupported.
- **Some Vercel-only features have no direct equivalent** (Edge Config, `@vercel/og`, Analytics, Speed Insights, ISR timing, image optimisation). They are reported rather than converted.
- **Monorepos with shared workspace packages** are the setup most likely to break `cf build`.
- **The `decrypt=true` behaviour is partly undocumented.** If Vercel tightens it, more variables move into the "enter by hand" list.
- **The Cloudflare GitHub App must be installed through the dashboard once.** Switchyard can detect when it's missing and link to the install page, but can't install it.

## Non-goals for now

- A separate preview Worker with its own runtime secrets.
- Copying data between storage services (agent instructions only).
- GitLab and Bitbucket repos. The Builds API accepts only GitHub at present.
- Vercel projects with no linked Git repo.
- Running several jobs in parallel.
- Deleting Vercel projects.
- Running Switchyard anywhere other than localhost.
- Log drains, webhooks and Vercel Analytics data.

## References

- [`cf` CLI overview (Flavio Copes)](https://flaviocopes.com/cloudflare-cf/)
- [vinext README](https://github.com/cloudflare/vinext)
- [Cloudflare: create an OAuth client](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)
- [Workers Builds API reference](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference)
- [Vercel access tokens](https://vercel.com/docs/accounts/access-tokens)
- [Vercel Sensitive environment variables](https://vercel.com/docs/environment-variables/sensitive-environment-variables)
