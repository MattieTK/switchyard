# Switchyard

Switchyard moves projects from Vercel to Cloudflare Workers. It runs on your machine and works in this order:

1. Reads a project from Vercel.
2. Converts it.
3. Deploys it to your Cloudflare account.
4. Connects Workers Builds, so later pushes deploy to Cloudflare.

It moves projects linked to a GitHub repository, and builds them with `cf`, the Cloudflare CLI:

| Project | How it moves |
| --- | --- |
| Next.js | Converted with [vinext](https://github.com/cloudflare/vinext). Apps older than Next.js 16 are upgraded first. |
| React Router 7 or later (framework mode) | Set up with `cf init`, which adds the Cloudflare Vite plugin and a Worker entry. |
| Vite apps, such as React, Vue, Svelte, Solid or Preact single-page apps | Set up with `cf init`, and served as static assets with a single-page fallback. |
| Static sites: Create React App, Gatsby, Docusaurus, Vue CLI, Eleventy, Hexo, Ember, Parcel, Storybook and others, or no framework at all | Built as Vercel built them, then the output folder is served as static assets. |

The projects list says why a project can't move yet, for example SvelteKit, Nuxt, Astro and Angular, which `cf` can't build at this point, and Remix 2, which needs upgrading to React Router 7 first.

## What it changes

- **GitHub:** pushes a `cloudflare-migration` branch and opens a pull request. Nothing else is pushed. If OpenAI fixes a failed Cloudflare build, its fix is a further commit on that branch, and Switchyard comments on the pull request.
- **Cloudflare:**
  - Creates a Worker. For apps that run server code (Next.js and React Router), your production variables are stored as its secrets. Vite apps and static sites only use variables while they build, so they go to Workers Builds alone.
  - Creates a KV namespace for vinext's cache, for Next.js apps with KV caching (the default).
  - Connects the repository to Workers Builds.
  - Creates two triggers:
    - production, on your production branch;
    - preview, on all other branches, which are built but not deployed.
- **Vercel:** nothing. Vercel keeps serving your domains until a later cut-over step.

Before anything changes, Switchyard shows a plan for each project. The plan covers where each variable goes, which values you need to enter, crons, Vercel-only features, storage and domains.

## Requirements

- Node.js 22.18 or later, pnpm and git
- The GitHub CLI, logged in (`gh auth login`), or a fine-grained GitHub token
- A Vercel access token (the app shows how to create one)
- A Cloudflare account. You log in through the browser.
- Optional: a ChatGPT plan that includes Codex, or an OpenAI API key, to have a model fix builds and deploys that fail

You don't need the package manager of each project you migrate. npm comes with Node.js, and a missing Yarn or pnpm is set up through Corepack in Switchyard's own folder. Bun projects need Bun installed.

## Running it

```bash
pnpm install
pnpm start
```

`pnpm start` builds the web UI, starts Switchyard on `http://localhost:4417` and opens it in your browser. It prints a link with a one-time token in the terminal, for example:

```
Switchyard is running at http://localhost:4417/?t=…
```

Switchyard listens on this machine only (`127.0.0.1`), and the browser needs that link: open it again if you use another browser or tab. Stop Switchyard with Ctrl+C. Jobs that were running are listed the next time it starts, and you can retry them.

### Migrating a project

1. **Connect:** paste a Vercel token, use your `gh` login or a GitHub token, and log in to Cloudflare in the browser. Choose the Cloudflare account to deploy to; accounts where you can only read Workers can't be chosen. A last, optional step lets you sign in with ChatGPT, so failed builds can be fixed with AI (see below). You can skip it and sign in later from a failed migration.
2. **Projects:** pick one or more Vercel projects.
3. **Plan:** review the plan for each project. You can change the Worker name and the Next.js caching, enter values for variables Vercel doesn't return, and choose upgrade options (below). Approving starts the migration.
4. **Job:** watch each step and its log. If a step needs something from you, such as installing the Cloudflare GitHub App, the job pauses and says what to do. Failed steps can be retried.

### Fixing failed builds with OpenAI

On the Connect page, select **Sign in with ChatGPT**. Switchyard shows a code: open `auth.openai.com/codex/device`, sign in and enter it. This is the device sign-in the Codex CLI uses, and that local agents such as Hermes Agent use too. Fixes then count towards your ChatGPT plan's Codex usage limits, so the plan must include Codex. Switchyard names itself to OpenAI as `switchyard`, and refreshes the sign-in as needed.

You can use an API key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys) instead, under **Use an API key instead**. Usage is then billed to the key's organisation.

Then choose a model: the list shows the models your plan or key can use, best first. The plan screen then offers **Fix build errors with OpenAI**, which is on by default. When one of these fails, the model tries to fix it:

- **The local build:** the model sees the build's output, can read, search and edit files in the working copy and add packages, and runs the build again to check its fix.
- **The first deploy:** the same, checking with `cf deploy`.
- **The first Cloudflare build:** the model gets the Workers Builds log and checks its fix with a clean install and build on this machine. Switchyard then commits the fix to the migration branch, comments on the pull request and starts another build. It does this at most twice.

If a plan didn't opt in, a failed build, deploy or Cloudflare build offers **Fix with AI** on the job page, which turns it on for that migration and runs the step again; after a failed Cloudflare build, the model starts from that build's log. If you haven't signed in, the job page offers **Sign in with ChatGPT** instead, and the Connect page then takes you back to the migration.

The model is told where the migration is: the steps already done and what they produced (such as the branch and pull request), the step that failed, the steps still to run, and so where its changes end up, either committed with the conversion by the push step, or, once the branch is on GitHub, as a new commit on it.

The model can't run other commands, and it can only change files inside the working copy, outside `.git` and `node_modules`. Secret values are hidden in everything sent to OpenAI, and `.env` and `.dev.vars` files are never read. Each fix is listed in the pull request for you to review. If the model can't fix the failure, the step fails as it would without OpenAI, and the log shows what the model tried. Nothing is stored at OpenAI between requests.

### Upgrade options

Apps on Next.js older than 16 are upgraded with the official Next.js codemods, because vinext needs Next.js 16. By default only the required migrations run. The plan screen offers these opt-ins when they apply:

- **Adoption codemods:** also run the optional codemods that move the app onto newer Next.js features.
- **ESLint migration:** move from `next lint`, which Next.js 16 removed, to the ESLint CLI.
- **Update flagged packages:** update packages the upgrade reports as incompatible with the new React to the first release that supports it.
- **Switch to pnpm:** move an npm, Yarn or bun project to pnpm. `pnpm import` keeps the versions from npm and Yarn lockfiles. Not offered for workspaces.

### What the pull request can contain

Besides the converter's own files (`cloudflare.config.ts`, the package changes, and `vite.config.ts` for vinext and `cf init` or `wrangler.config.ts` for static sites), Switchyard can make these changes, and the pull request lists each one it made:

- `switchyard-entry.ts`, which runs your `vercel.json` cron routes as Cron Triggers. Static sites and Vite apps run no server code for crons to call, so the plan lists their crons as left behind.
- A `build:cloudflare` script that keeps the steps your build runs before the framework's build, such as `prisma generate` before `next build` or `tsc -b` before `vite build`. For static sites, it runs your build and then `cf build`. Workers Builds runs it.
- `@vercel/react-router`'s preset removed from `react-router.config.ts`, and Node.js compatibility turned on, so loaders keep reading `process.env`.
- `.nvmrc` or `.node-version` raised to 22 when they pin an older Node.js, because `cf` needs 22 or later.
- `"packageManager": "yarn@1.22.22"` for projects with a Yarn 1 lockfile, so Workers Builds keeps using Yarn 1.
- Lockfiles of package managers the project doesn't use, removed.
- `output: "standalone"` in `next.config` limited to builds outside Cloudflare, since the Cloudflare build can't produce it.
- Build-script approvals in `pnpm-workspace.yaml` for packages the conversion added, and `npmPreapprovedPackages` in `.yarnrc.yml` for packages Yarn held back as too new.

### Where it keeps data

| What | Default location |
| --- | --- |
| Credentials, including the ChatGPT sign-in or OpenAI key, readable only by you | `~/.config/switchyard/credentials.json` |
| Jobs and their logs | `~/.config/switchyard/jobs/` |
| Working copies of repositories | `~/.cache/switchyard/work/` |
| Yarn and pnpm set up through Corepack | `~/.cache/switchyard/bin/` |

`XDG_CONFIG_HOME` and `XDG_CACHE_HOME` replace `~/.config` and `~/.cache` when set.

### Environment variables

| Variable | Effect |
| --- | --- |
| `SWITCHYARD_HOME` | Keeps everything in one folder instead, in its `config/` and `cache/` subfolders. |
| `SWITCHYARD_NO_OPEN` | Set to any value to print the link without opening a browser. |
| `SWITCHYARD_PORT` | For development: runs on another port, so a second copy can run beside a normal one. |
| `SWITCHYARD_CLOUDFLARE_CLIENT_ID` | For development: the Cloudflare OAuth client to log in with. Another port needs a client that lists that port's callback URL. |

A second copy for development, with its own data and port:

```bash
SWITCHYARD_HOME=~/switchyard-dev SWITCHYARD_PORT=4418 SWITCHYARD_CLOUDFLARE_CLIENT_ID=<client-id> pnpm start
```

## Troubleshooting

- **"Port 4417 is already in use":** Switchyard needs this exact port, because the Cloudflare login redirects to it. Stop the other process (`lsof -i :4417`).
- **"The web UI hasn't been built yet":** start Switchyard with `pnpm start`, which builds it, or run `pnpm build:web` first.
- **"Install the GitHub App":** Cloudflare needs its GitHub App on the repository's account or organisation before it can build. Install the app, then select Check again.
- **"No Workers Builds token":** in the Cloudflare dashboard, open any Worker, go to Settings → Builds and connect a repository once. Then select Check again.
- **Vercel Functions and Routing Middleware:** files in a top-level `api/` folder and a top-level `middleware.ts` run on Vercel beside any framework. Switchyard doesn't move them yet, and the plan warns when a project has them.
- **A static site served from its repository folder:** Switchyard deploys a static site from a folder of its own. Move the files into `public/`, or set an Output Directory in the Vercel project's settings.
- **Sensitive variables:** Vercel never returns their values. Enter them on the plan screen, or skip them and set them later.
- **npm projects:** if vinext's dependencies want a newer React than your project pins, Switchyard adds `legacy-peer-deps=true` to `.npmrc` and says so in the pull request.
- **A Node.js version manager that switches per project:** some, such as Volta or fnm with automatic switching, run a project's commands on the Node.js version it pins. If that's older than 22, the conversion can fail in `vinext init`. Run Switchyard where Node.js 22 or later is used for every folder, or raise the project's pin first.

## Development

```bash
pnpm test            # unit tests
pnpm test:fixtures   # converts and builds real Next.js, Vite and static apps with cf (slow)
pnpm typecheck
pnpm dev             # restarts the server when its code changes
pnpm dev:web         # rebuilds the web UI when it changes; run beside pnpm dev
```

## Licence

MIT. See [LICENSE](LICENSE).
