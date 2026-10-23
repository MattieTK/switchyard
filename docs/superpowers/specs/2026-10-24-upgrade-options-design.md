# Upgrade options for old apps – design

Date: 2026-10-24
Status: agreed in conversation, implemented for review

## Purpose

Apps below Next.js 16 must be upgraded before vinext can convert them, and Switchyard does that with the official Next.js codemods. Until now it ran every codemod the upgrade offers and left nothing for the user to decide. People moving very old apps want control over how far Switchyard changes their code and dependencies, so the plan screen now offers opt-in choices. With nothing ticked, Switchyard does only what vinext requires.

### Success criteria

- With no options ticked, an old app is upgraded with only the required migrations, and the pull request is as small as Switchyard can make it.
- Each option is off by default, explained in a sentence on the plan screen, and shown only when it applies.
- Every change an option makes is listed in the pull request.
- engineer-cafe-navigator, which failed in the ESLint migration codemod, converts with the default choices.

## Decisions

| Topic | Decision |
| --- | --- |
| Goal | Control over how much changes (not maximum compatibility) |
| Default | Minimal: Next.js 16 with its required migrations only |
| Upgrade opt-ins | Feature-adoption codemods; ESLint migration; update packages the upgrade flags as incompatible |
| React upgrade option | Not offered: vinext needs React 19.3.1 or later, so it isn't optional |
| Package manager | Opt-in switch to pnpm only, offered on any non-pnpm project, with a hint for Yarn 1 and mixed lockfiles |
| Wiring | Typed options on `MigrationPlan`, following the `nextCache` path (approach A) |

## Data flow

- `MigrationPlan.upgrade: { from: string; to: string } | null` comes from a new optional adapter method, `upgradeFor(packageJson)`. The Next.js adapter reports, for example, `13.4.12` to `16.4.1`.
- `MigrationPlan.pnpmSwitch: { available: true; hint: string | null; reresolves: boolean } | { available: false; reason: string } | null` describes the pnpm offer. It's `null` for pnpm projects. It's unavailable when `package.json` has a `workspaces` field, or when no lockfile sits in the project folder but one exists at the repository root. `reresolves` is true when no importable lockfile exists (`bun.lock` or `bun.lockb`, or no lockfile at all).
- `MigrationPlan.options: { adoptionCodemods, eslintMigration, updateFlaggedPackages, switchToPnpm }` are all `false` in a fresh plan.
- The approve request (`POST /api/jobs`) gains an `options` object, validated by zod. The service rejects an option the plan didn't offer, with a `UserInputError`.
- When `switchToPnpm` is chosen, the stored plan gets `packageManager: "pnpm"` and `switchedFrom: <the original manager>`, so every later step, including the Workers Builds commands, uses pnpm.
- `AdapterOptions` carries `adoptionCodemods`, `eslintMigration` and `updateFlaggedPackages` next to `nextCache`.

## Upgrade options

- The upgrade always runs `@next/codemod upgrade 16.4.1 --yes`. It adds `--skip-adoption` unless `adoptionCodemods` is set, and `--skip-eslint-upgrade` unless `eslintMigration` is set.
- If `eslintMigration` isn't set and a `package.json` script runs `next lint` (removed in Next.js 16), the pull request lists the script and names the option that would migrate it.
- With `updateFlaggedPackages`, each package in the codemod's incompatible report that `package.json` lists directly is looked up with `npm view <name>@latest version peerDependencies --json`, run in the project folder so `.npmrc` applies.
  - If the latest release's peer ranges accept every installed version the report names, the package is installed at `^<latest>`, and the pull request says so, noting that major updates can change APIs.
  - Otherwise, or when the lookup fails, it's left alone with a warning.
  - Indirect packages keep the existing warning.
- Yarn's release-age retry, which preapproves what Yarn held back and runs again, becomes a general install helper used by `vinext init` and by these updates.

## pnpm switch

When `plan.switchedFrom` is set, `convertStep` does the following after resetting to a clean checkout:

1. Sets up pnpm.
2. Runs `pnpm import` if the project folder has `package-lock.json`, `npm-shrinkwrap.json` or `yarn.lock`. If it fails, the step fails with a message suggesting unticking the option.
3. Removes `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `bun.lock` and `bun.lockb` from the project folder.
4. Sets `packageManager` to `pnpm@<the pnpm version Switchyard used>`.
5. Reports leftovers: scripts that call `yarn` or `bun`, and Yarn-only files (`.yarnrc.yml`, `.yarn/`, `.pnp.cjs`).

The Yarn 1 pin doesn't run, because the plan's manager is now pnpm.

## Errors

- If the upgrade codemod fails, the error names the options that affect it.
- Registry lookups that fail skip the package with a warning.
- A failed install of updates fails the step and names the option.
- Retry keeps the approved choices. Changing them means building the plan again, as with the cache preset.

## Testing

- Unit tests with fake runners cover:
  - codemod flags
  - the structured incompatible-package report
  - the update decision (a pure function)
  - the install helper
  - each pnpm switch case
  - plan offers
  - service validation
- The plan screen is checked with typecheck and the Vite build.
- Real projects: the old apps from the October 2026 run, with default choices and with every option ticked.

## Not covered

- Converting workspace configuration (npm, Yarn or bun workspaces) to `pnpm-workspace.yaml`.
- Switching to npm, bun or Yarn 4.
- Rewriting scripts that call another package manager.
