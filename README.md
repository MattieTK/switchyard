# Switchyard

Switchyard moves projects from Vercel to Cloudflare Workers. It runs on your machine and works in this order:

1. Reads a project from Vercel.
2. Converts it.
3. Deploys it to your Cloudflare account.
4. Connects Workers Builds, so later pushes deploy to Cloudflare.

At this point it supports Next.js projects linked to a GitHub repository. They are converted with [vinext](https://github.com/cloudflare/vinext) and built with `cf`, the Cloudflare CLI.

## What it changes

- **GitHub:** pushes a `cloudflare-migration` branch and opens a pull request. Nothing else is pushed.
- **Cloudflare:**
  - Creates a Worker, with your production variables stored as secrets.
  - Connects the repository to Workers Builds.
  - Creates two triggers:
    - production, on your production branch;
    - preview, on all other branches, which are built but not deployed.
- **Vercel:** nothing. Vercel keeps serving your domains until a later cut-over step.

Before anything changes, Switchyard shows a plan for each project. The plan covers where each variable goes, which values you need to enter, crons, Vercel-only features, storage and domains.

## Requirements

- Node.js 22.18 or later, and pnpm
- The GitHub CLI, logged in (`gh auth login`), or a fine-grained GitHub token
- A Vercel access token (the app shows how to create one)
- A Cloudflare account. You log in through the browser.

## Running it

```bash
pnpm install
pnpm start
```

`pnpm start` builds the web UI and then opens `http://localhost:4417` in your browser. It listens on this machine only, and every page load needs the link printed in the terminal.

Credentials are stored in `~/.config/switchyard/credentials.json`, which only you can read. Working copies go in `~/.cache/switchyard/work`. Set `SWITCHYARD_HOME` to keep everything in one other folder instead.

## Troubleshooting

- **"Port 4417 is already in use":** Switchyard needs this exact port, because the Cloudflare login redirects to it. Stop the other process (`lsof -i :4417`).
- **"Install the GitHub App":** Cloudflare needs its GitHub App on the repository's account or organisation before it can build. Install the app, then select Check again.
- **"No Workers Builds token":** in the Cloudflare dashboard, open any Worker, go to Settings → Builds and connect a repository once. Then select Check again.
- **Sensitive variables:** Vercel never returns their values. Enter them on the plan screen, or skip them and set them later.
- **npm projects:** if vinext's dependencies want a newer React than your project pins, Switchyard adds `legacy-peer-deps=true` to `.npmrc` and says so in the pull request.

## Development

```bash
pnpm test            # unit tests
pnpm test:fixtures   # converts and builds a real Next.js app with vinext and cf (slow)
pnpm typecheck
```

The design is in `docs/superpowers/specs/`. `docs/spikes.md` records what was checked against the real APIs.
