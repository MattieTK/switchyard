# Switchyard core (plan 1 of 3) – implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Switchyard server and UI that can take a Next.js project on Vercel to a PR, a deployed Cloudflare Worker and a Workers Builds connection, with env vars and secrets copied.

**Architecture:** A single Node package. A Hono server on `127.0.0.1:4417` serves a React SPA and a JSON API. The pure modules are `translate/` and `codegen/`. The I/O modules are `clients/`, `auth/` and `exec.ts`, each with its dependencies injected. A resumable step pipeline (`pipeline/`) combines them and shells out to `git`, `vinext` and `cf`. Phase 1 builds a read-only plan. Phase 2 runs eight steps and streams progress to the UI over SSE.

**Tech stack:** Node ≥ 22.18 (runs `.ts` directly through native type stripping), pnpm, TypeScript 7 (`tsc --noEmit` only), Hono 4 with `@hono/node-server`, zod 4, magicast 0.5 for editing `cloudflare.config.ts`, React 19 with Vite 8 for the SPA, and vitest 5.

**Spec:** `docs/superpowers/specs/2026-10-14-switchyard-design.md`

### How this plan relates to the spec

The spec is split across three plans, each producing working software:

- **Plan 1 (this document):** spikes, the foundation, the Next.js adapter, phase 1 (plan), phase 2 (convert and connect), and the Connect, Projects, Plan review and Job screens.
- **Plan 2:** the other Vite-based adapters (static, plain Vite, SvelteKit, React Router, Nuxt, Astro), each with a fixture, plus `_redirects` and `_headers` generation from `vercel.json`.
- **Plan 3:** phase 3 cut-over (custom domains and Vercel Git disconnect) and storage moves (R2/KV/D1 bindings and `CLOUDFLARE_MIGRATION.md`).

Plans 2 and 3 are written after this plan lands, so they can use what the spikes found.

### Departures from the spec, decided while planning

Each of these is based on probes run on 2026-10-14 against `cf` 1.0.0-beta.14/17 and vinext 1.1.0:

1. **Runtime secrets.** These are uploaded with the first `cf deploy --secrets-file` and declared in `cloudflare.config.ts` as `bindings.secret()`, rather than set with separate secret API calls. The spec's step 8 is merged into the deploy step.
2. **Preview trigger.** Until spike 2 finds a `cf` command for preview uploads, the preview trigger builds but doesn't deploy. Its deploy command is a harmless `echo`, so preview branches can never overwrite production.
3. **Production trigger.** This runs `cf build` as the build command and `cf deploy --prebuilt` as the deploy command.
4. **Storage detection.** This uses env var names and dependencies. The Vercel integrations API is not called.
5. **Redirects, rewrites and headers.** For Next.js projects, those in `vercel.json` are reported as manual moves to `next.config.js`. Generating `_redirects` and `_headers` arrives with plan 2's non-Next adapters.
6. **Port.** The server always uses port 4417, because the Cloudflare OAuth redirect URI must match exactly.

## Global constraints

- Node `>=22.18`. Run TypeScript directly with `node file.ts`, so use only erasable syntax: no `enum`, no `namespace`, no constructor parameter properties. Relative imports must end in `.ts`.
- Use pnpm (`pnpm add`, `pnpm dlx`). Never use npm or npx for this repo's own tooling.
- The server binds to `127.0.0.1` only, on port `4417`. It accepts the `Host` header only when it is `localhost:4417` or `127.0.0.1:4417`.
- Every `/api` request needs the launch token, in the `x-switchyard-token` header or a `t` query parameter.
- The config dir is `~/.config/switchyard` and the cache dir is `~/.cache/switchyard`. `SWITCHYARD_HOME` overrides both, for tests and spikes.
- Credential and secret files are mode `0600`, inside directories with mode `0700`.
- No env var value or token may appear in logs, job JSON files, SSE events or API responses sent to the browser.
- The migration branch is always `cloudflare-migration`. It is the only branch Switchyard ever pushes to, and the only branch it force-pushes.
- This plan makes no writes to Vercel at all.
- vinext is pinned to `1.1.0`.
- UI copy and messages use British English and en dashes with spaces ( – ). Avoid marketing language.
- Commits follow Conventional Commits, without attribution lines.

## Review focus

These are five failure modes the spec implies but no feature test would naturally cover. Each one has a test in the task listed:

1. **The repo belongs to an organisation the GitHub token can't access** (SSO not authorised, or a private repo). The plan should show a blocker that names the repo and mentions SSO, rather than a bare 404. The test is in Task 10 (client message) and Task 16 (blocker).
2. **A Vercel env var collides with a binding vinext creates** (`ASSETS`, `IMAGES`, `VINEXT_KV_CACHE`), or isn't a valid binding name. It should be skipped with a reason, not break the generated config. The test is in Task 11.
3. **Switchyard is stopped while a step is running.** On the next start the job should show that step as failed and retryable, not stuck at "running". The test is in Task 17.
4. **Port 4417 is already in use.** The user should see a clear message saying why that exact port is needed, not a stack trace. The test is in Task 24.
5. **The production branch is named `cloudflare-migration`, or `rootDirectory` points at a folder with no `package.json`.** The plan should be blocked, so Switchyard never force-pushes over the production branch and never fails late. The test is in Task 16.

---

## File structure

```
package.json, tsconfig.json, vitest.config.ts, vitest.fixtures.config.ts, vite.config.ts, .gitignore, README.md
src/
  config.ts                 constants: port, OAuth client ID and scopes, branch and trigger names
  paths.ts                  config/cache/jobs/work directories
  fs-secure.ts              atomic 0600 writes
  redact.ts                 secret value redactor
  http.ts                   JSON client with retry/backoff and ApiError
  exec.ts                   CommandRunner (spawn, no shell) and CommandError
  auth/
    store.ts                credentials.json
    pkce.ts                 PKCE pair and random tokens
    cloudflare-oauth.ts     authorise URL, code exchange, refresh, token provider, pending flows
    github.ts               gh-first token resolution and git auth env
  clients/
    vercel.ts  cloudflare.ts  github.ts  factory.ts
  translate/
    package-json.ts  package-manager.ts  env-plan.ts  vercel-json.ts
    storage.ts  features.ts  token-scope.ts
  codegen/
    config-edit.ts  cron-entry.ts  gitignore.ts  pr-body.ts
  adapters/
    types.ts  nextjs.ts  registry.ts
  pipeline/
    plan.ts  types.ts  job-store.ts  events.ts  runner.ts  queue.ts
    build-status.ts  service.ts
    steps/repo.ts  steps/release.ts  steps/builds.ts  steps/index.ts
  server/
    guard.ts  app.ts  listen-error.ts  main.ts
    routes/connect.ts  routes/jobs.ts
web/
  index.html
  src/main.tsx  src/api.ts  src/router.ts  src/styles.css  src/App.tsx
  src/pages/Connect.tsx  src/pages/Projects.tsx  src/pages/PlanReview.tsx  src/pages/Job.tsx
tests/
  helpers/fake-fetch.ts  helpers/fake-runner.ts  helpers/tmp.ts
  (one *.test.ts per module, mirroring src/)
  fixtures/apps/nextjs-basic/…   fixtures/nextjs.fixture.test.ts
docs/spikes.md
```

---

### Task 1: Scaffold the package and the redactor

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `vitest.fixtures.config.ts`, `.gitignore`
- Create: `src/redact.ts`, `tests/redact.test.ts`, `tests/helpers/tmp.ts`

**Interfaces:**
- Produces: `interface Redactor { add(value: string | undefined): void; redact(text: string): string }` and `createRedactor(): Redactor`. Also `makeTempDir(): Promise<string>` for tests.

- [ ] **Step 1: Create the package files**

Working directory: `~/GitHub/switchyard` (the repo already exists with the spec committed).

`package.json`:

```json
{
  "name": "switchyard",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Move Vercel projects to Cloudflare Workers",
  "engines": { "node": ">=22.18" },
  "scripts": {
    "start": "node src/server/main.ts",
    "dev": "node --watch src/server/main.ts",
    "build:web": "vite build",
    "dev:web": "vite build --watch",
    "test": "vitest run",
    "test:fixtures": "vitest run --config vitest.fixtures.config.ts",
    "typecheck": "tsc --noEmit"
  }
}
```

Then install the dependencies:

```bash
pnpm add hono@4.13.13 @hono/node-server@2.1.5 zod@4.6.7 magicast@0.5.5 open@11.0.4
pnpm add -D typescript@7.0.2 vitest@5.0.4 vite@8.3.4 @vitejs/plugin-react@6.1.2 react@19.3.0 react-dom@19.3.0 @types/node@26.6.5 @types/react@19.3.0 @types/react-dom@19.3.0
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2024", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "skipLibCheck": true
  },
  "include": ["src", "web", "tests", "*.config.ts"],
  "exclude": ["tests/fixtures/apps"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/fixtures/**", "node_modules/**"],
  },
});
```

`vitest.fixtures.config.ts`:

```ts
import { defineConfig } from "vitest/config";

// Slow tests that run real vinext and cf builds. No Cloudflare login needed.
export default defineConfig({
  test: {
    include: ["tests/fixtures/**/*.fixture.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
```

`.gitignore`:

```
node_modules/
dist/
.switchyard-dev/
*.tmp
```

`tests/helpers/tmp.ts`:

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "switchyard-test-"));
}
```

- [ ] **Step 2: Write the failing redactor tests**

`tests/redact.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createRedactor } from "../src/redact.ts";

describe("createRedactor", () => {
  it("replaces registered values", () => {
    const r = createRedactor();
    r.add("s3cret-value");
    expect(r.redact("token=s3cret-value; again s3cret-value")).toBe("token=***; again ***");
  });

  it("replaces longer values before their prefixes", () => {
    const r = createRedactor();
    r.add("abcd");
    r.add("abcdefgh");
    expect(r.redact("abcdefgh abcd")).toBe("*** ***");
  });

  it("ignores empty, undefined and very short values so logs stay readable", () => {
    const r = createRedactor();
    r.add(undefined);
    r.add("");
    r.add("abc");
    expect(r.redact("abc true 1")).toBe("abc true 1");
  });

  it("also replaces the JSON-escaped form of a value", () => {
    const r = createRedactor();
    r.add('pa"ss\nword');
    expect(r.redact(JSON.stringify({ v: 'pa"ss\nword' }))).toBe('{"v":"***"}');
  });

  it("returns text unchanged when nothing is registered", () => {
    expect(createRedactor().redact("hello")).toBe("hello");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test tests/redact.test.ts`
Expected: FAIL, because `src/redact.ts` can't be resolved.

- [ ] **Step 4: Implement the redactor**

`src/redact.ts`:

```ts
export interface Redactor {
  add(value: string | undefined): void;
  redact(text: string): string;
}

// Values shorter than this are left alone: redacting "true" or "1" everywhere
// would make logs unreadable, and such values are not meaningful secrets.
const MIN_LENGTH = 4;

export function createRedactor(): Redactor {
  const values = new Set<string>();
  let ordered: string[] = [];

  return {
    add(value) {
      if (!value || value.length < MIN_LENGTH) return;
      const escaped = JSON.stringify(value).slice(1, -1);
      for (const v of new Set([value, escaped])) values.add(v);
      // Longest first, so a value never leaves a partial match of a longer one.
      ordered = [...values].sort((a, b) => b.length - a.length);
    },
    redact(text) {
      let out = text;
      for (const v of ordered) out = out.split(v).join("***");
      return out;
    },
  };
}
```

- [ ] **Step 5: Run the tests and the type check**

Run: `pnpm test tests/redact.test.ts && pnpm typecheck`
Expected: 5 tests pass, and `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts vitest.fixtures.config.ts .gitignore src/redact.ts tests
git commit -m "chore: scaffold switchyard package with secret redactor"
```

---

### Task 2: JSON HTTP client with retry and ApiError

**Files:**
- Create: `src/http.ts`, `tests/http.test.ts`, `tests/helpers/fake-fetch.ts`

**Interfaces:**
- Produces:
  - `type FetchFn = (input: string, init?: RequestInit) => Promise<Response>`
  - `type Service = "vercel" | "cloudflare" | "github"`
  - `class ApiError extends Error { service: Service; status: number; auth: boolean }`
  - `isAuthError(e: unknown): e is ApiError`
  - `interface JsonRequest { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; query?: Record<string, string | number | undefined>; body?: unknown; allow404?: boolean }`
  - `interface JsonClient { request<T>(path: string, req?: JsonRequest): Promise<T> }`
  - `createJsonClient(o: JsonClientOptions): JsonClient`
  - test helpers `fakeFetch(responses)` returning `{ fetch, calls }`, and `json(body, status?, headers?)`

- [ ] **Step 1: Write the fetch test helper**

`tests/helpers/fake-fetch.ts`:

```ts
import type { FetchFn } from "../../src/http.ts";

export interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

type Responder = Response | ((url: string, init?: RequestInit) => Response);

export function fakeFetch(responses: Responder[]): { fetch: FetchFn; calls: RecordedCall[] } {
  const queue = [...responses];
  const calls: RecordedCall[] = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    return typeof next === "function" ? next(url, init) : next;
  };
  return { fetch, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
```

- [ ] **Step 2: Write the failing tests**

`tests/http.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ApiError, createJsonClient, isAuthError } from "../src/http.ts";
import { fakeFetch, json } from "./helpers/fake-fetch.ts";

function client(responses: Parameters<typeof fakeFetch>[0], sleeps: number[] = []) {
  const f = fakeFetch(responses);
  const c = createJsonClient({
    service: "cloudflare",
    baseUrl: "https://api.example.com/v4",
    fetch: f.fetch,
    token: async () => "tok-123",
    errorMessage: (b) => (b as { message?: string })?.message,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { c, calls: f.calls };
}

describe("createJsonClient", () => {
  it("sends bearer auth, query and JSON body, and parses the response", async () => {
    const { c, calls } = client([json({ ok: 1 })]);
    const res = await c.request<{ ok: number }>("/things", {
      method: "POST",
      query: { a: "1", skip: undefined, n: 2 },
      body: { x: true },
    });
    expect(res).toEqual({ ok: 1 });
    expect(calls[0]?.url).toBe("https://api.example.com/v4/things?a=1&n=2");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-123");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(calls[0]?.init?.body).toBe('{"x":true}');
  });

  it("retries 429 using Retry-After, then succeeds", async () => {
    const sleeps: number[] = [];
    const { c } = client([json({}, 429, { "retry-after": "2" }), json({ ok: true })], sleeps);
    expect(await c.request("/x")).toEqual({ ok: true });
    expect(sleeps).toEqual([2000]);
  });

  it("retries 5xx with exponential backoff and gives up after three retries", async () => {
    const sleeps: number[] = [];
    const { c, calls } = client(
      [json({ message: "a" }, 503), json({}, 503), json({}, 503), json({ message: "down" }, 503)],
      sleeps,
    );
    await expect(c.request("/x")).rejects.toThrow("cloudflare API error 503: down");
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  it("does not retry other 4xx responses", async () => {
    const { c, calls } = client([json({ message: "bad input" }, 400)]);
    const err = await c.request("/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect(isAuthError(err)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("marks 401 as an auth error", async () => {
    const { c } = client([json({ message: "expired" }, 401)]);
    const err = await c.request("/x").catch((e: unknown) => e);
    expect(isAuthError(err)).toBe(true);
  });

  it("uses isAuthFailure for service-specific auth responses", async () => {
    const f = fakeFetch([json({ error: { invalidToken: true } }, 403)]);
    const c = createJsonClient({
      service: "vercel",
      baseUrl: "https://api.vercel.com",
      fetch: f.fetch,
      token: async () => "t",
      errorMessage: () => "Not authorized",
      isAuthFailure: (status, body) =>
        status === 403 && (body as { error?: { invalidToken?: boolean } }).error?.invalidToken === true,
    });
    expect(isAuthError(await c.request("/x").catch((e: unknown) => e))).toBe(true);
  });

  it("returns null for 404 when allow404 is set", async () => {
    const { c } = client([json({ message: "nope" }, 404)]);
    expect(await c.request("/x", { allow404: true })).toBeNull();
  });

  it("returns undefined for 204", async () => {
    const { c } = client([new Response(null, { status: 204 })]);
    expect(await c.request("/x", { method: "DELETE" })).toBeUndefined();
  });

  it("falls back to the status text when the error body is not JSON", async () => {
    const { c } = client([new Response("<html>oops</html>", { status: 400, statusText: "Bad Request" })]);
    await expect(c.request("/x")).rejects.toThrow("cloudflare API error 400: Bad Request");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test tests/http.test.ts`
Expected: FAIL, because `src/http.ts` can't be resolved.

- [ ] **Step 4: Implement the client**

`src/http.ts`:

```ts
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export type Service = "vercel" | "cloudflare" | "github";

export class ApiError extends Error {
  readonly service: Service;
  readonly status: number;
  readonly auth: boolean;

  constructor(service: Service, status: number, message: string, auth = false) {
    super(`${service} API error ${status}: ${message}`);
    this.name = "ApiError";
    this.service = service;
    this.status = status;
    this.auth = auth;
  }
}

export function isAuthError(e: unknown): e is ApiError {
  return e instanceof ApiError && e.auth;
}

export interface JsonRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  allow404?: boolean;
}

export interface JsonClient {
  request<T>(path: string, req?: JsonRequest): Promise<T>;
}

export interface JsonClientOptions {
  service: Service;
  baseUrl: string;
  fetch: FetchFn;
  token: () => Promise<string>;
  errorMessage: (body: unknown) => string | undefined;
  isAuthFailure?: (status: number, body: unknown) => boolean;
  headers?: Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createJsonClient(o: JsonClientOptions): JsonClient {
  const sleep = o.sleep ?? defaultSleep;
  const maxRetries = o.maxRetries ?? 3;

  return {
    async request<T>(path: string, req: JsonRequest = {}): Promise<T> {
      const url = new URL(o.baseUrl + path);
      for (const [k, v] of Object.entries(req.query ?? {})) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
      const hasBody = req.body !== undefined;

      for (let attempt = 0; ; attempt++) {
        const res = await o.fetch(url.toString(), {
          method: req.method ?? "GET",
          headers: {
            Authorization: `Bearer ${await o.token()}`,
            Accept: "application/json",
            ...(hasBody ? { "Content-Type": "application/json" } : {}),
            ...o.headers,
          },
          body: hasBody ? JSON.stringify(req.body) : undefined,
        });

        if (res.ok) {
          if (res.status === 204) return undefined as T;
          const text = await res.text();
          return (text ? JSON.parse(text) : undefined) as T;
        }
        if (res.status === 404 && req.allow404) return null as T;

        const body = await readBody(res);
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < maxRetries) {
          await sleep(retryDelay(res, attempt));
          continue;
        }
        const auth = res.status === 401 || (o.isAuthFailure?.(res.status, body) ?? false);
        throw new ApiError(o.service, res.status, o.errorMessage(body) ?? res.statusText, auth);
      }
    },
  };
}

function retryDelay(res: Response, attempt: number): number {
  const after = Number(res.headers.get("retry-after"));
  if (Number.isFinite(after) && after > 0) return Math.min(after, 60) * 1000;
  return 500 * 2 ** attempt;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test tests/http.test.ts && pnpm typecheck`
Expected: 9 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/http.ts tests/http.test.ts tests/helpers/fake-fetch.ts
git commit -m "feat: add JSON HTTP client with retry and typed API errors"
```

---

### Task 3: Paths, secure writes and the credential store

**Files:**
- Create: `src/paths.ts`, `src/fs-secure.ts`, `src/auth/store.ts`
- Test: `tests/paths.test.ts`, `tests/auth/store.test.ts`

**Interfaces:**
- Produces:
  - `interface Paths { configDir; cacheDir; credentialsFile; jobsDir; workDir: string }` and `resolvePaths(env?, home?): Paths`
  - `writeFileSecure(file: string, data: string): Promise<void>`
  - `interface VercelCredentials { token: string; scope: "account" | "team"; teamId?: string; teamName?: string; username?: string }`
  - `interface CloudflareCredentials { accessToken: string; refreshToken?: string; expiresAt: number; email?: string; accountId?: string; accountName?: string }`
  - `interface Credentials { vercel?: VercelCredentials; cloudflare?: CloudflareCredentials; githubPat?: string }`
  - `interface CredentialStore { read(): Promise<Credentials>; update(fn: (c: Credentials) => Credentials): Promise<Credentials> }` and `createCredentialStore(file: string): CredentialStore`

- [ ] **Step 1: Write the failing tests**

`tests/paths.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolvePaths } from "../src/paths.ts";

describe("resolvePaths", () => {
  it("uses ~/.config and ~/.cache by default", () => {
    const p = resolvePaths({}, "/home/u");
    expect(p.configDir).toBe("/home/u/.config/switchyard");
    expect(p.cacheDir).toBe("/home/u/.cache/switchyard");
    expect(p.credentialsFile).toBe("/home/u/.config/switchyard/credentials.json");
    expect(p.jobsDir).toBe("/home/u/.config/switchyard/jobs");
    expect(p.workDir).toBe("/home/u/.cache/switchyard/work");
  });

  it("respects XDG variables", () => {
    const p = resolvePaths({ XDG_CONFIG_HOME: "/x/c", XDG_CACHE_HOME: "/x/k" }, "/home/u");
    expect(p.configDir).toBe("/x/c/switchyard");
    expect(p.cacheDir).toBe("/x/k/switchyard");
  });

  it("puts everything under SWITCHYARD_HOME when set", () => {
    const p = resolvePaths({ SWITCHYARD_HOME: "/tmp/sy" }, "/home/u");
    expect(p.configDir).toBe("/tmp/sy/config");
    expect(p.cacheDir).toBe("/tmp/sy/cache");
  });
});
```

`tests/auth/store.test.ts`:

```ts
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/auth/store.ts";
import { makeTempDir } from "../helpers/tmp.ts";

describe("createCredentialStore", () => {
  it("returns an empty object when the file does not exist", async () => {
    const dir = await makeTempDir();
    expect(await createCredentialStore(join(dir, "c", "credentials.json")).read()).toEqual({});
  });

  it("writes with mode 0600 inside a 0700 directory", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "c", "credentials.json");
    await createCredentialStore(file).update((c) => ({ ...c, githubPat: "ghp_x" }));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "c"))).mode & 0o777).toBe(0o700);
  });

  it("round-trips updates", async () => {
    const dir = await makeTempDir();
    const store = createCredentialStore(join(dir, "credentials.json"));
    await store.update((c) => ({ ...c, vercel: { token: "vcp_1", scope: "team" } }));
    expect(await store.read()).toEqual({ vercel: { token: "vcp_1", scope: "team" } });
  });

  it("applies concurrent updates one after another without losing either", async () => {
    const dir = await makeTempDir();
    const store = createCredentialStore(join(dir, "credentials.json"));
    await Promise.all([
      store.update((c) => ({ ...c, githubPat: "a" })),
      store.update((c) => ({ ...c, vercel: { token: "v", scope: "account" } })),
    ]);
    expect(await store.read()).toEqual({ githubPat: "a", vercel: { token: "v", scope: "account" } });
  });

  it("reports a corrupt file with its path", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "credentials.json");
    await writeFile(file, "{not json");
    await expect(createCredentialStore(file).read()).rejects.toThrow(file);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/paths.test.ts tests/auth/store.test.ts`
Expected: FAIL, because the modules can't be resolved.

- [ ] **Step 3: Implement the modules**

`src/paths.ts`:

```ts
import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  configDir: string;
  cacheDir: string;
  credentialsFile: string;
  jobsDir: string;
  workDir: string;
}

export function resolvePaths(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): Paths {
  const base = env.SWITCHYARD_HOME;
  const configDir = base
    ? join(base, "config")
    : join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "switchyard");
  const cacheDir = base
    ? join(base, "cache")
    : join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "switchyard");
  return {
    configDir,
    cacheDir,
    credentialsFile: join(configDir, "credentials.json"),
    jobsDir: join(configDir, "jobs"),
    workDir: join(cacheDir, "work"),
  };
}
```

`src/fs-secure.ts`:

```ts
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Writes atomically (temp file + rename) so a crash never leaves a half-written
// credentials or secrets file, and keeps both the file and its folder private.
export async function writeFileSecure(file: string, data: string): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, file);
}
```

`src/auth/store.ts`:

```ts
import { readFile } from "node:fs/promises";
import { writeFileSecure } from "../fs-secure.ts";

export interface VercelCredentials {
  token: string;
  scope: "account" | "team";
  teamId?: string;
  teamName?: string;
  username?: string;
}

export interface CloudflareCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  email?: string;
  accountId?: string;
  accountName?: string;
}

export interface Credentials {
  vercel?: VercelCredentials;
  cloudflare?: CloudflareCredentials;
  githubPat?: string;
}

export interface CredentialStore {
  read(): Promise<Credentials>;
  update(fn: (c: Credentials) => Credentials): Promise<Credentials>;
}

export function createCredentialStore(file: string): CredentialStore {
  // Serialise writes so two requests updating different services can't race.
  let chain: Promise<unknown> = Promise.resolve();

  async function read(): Promise<Credentials> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
    try {
      return JSON.parse(text) as Credentials;
    } catch {
      throw new Error(`Credentials file ${file} is not valid JSON. Delete it and reconnect your accounts.`);
    }
  }

  return {
    read,
    update(fn) {
      const next = chain.then(async () => {
        const updated = fn(await read());
        await writeFileSecure(file, JSON.stringify(updated, null, 2));
        return updated;
      });
      chain = next.catch(() => undefined);
      return next;
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/paths.test.ts tests/auth/store.test.ts && pnpm typecheck`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts src/fs-secure.ts src/auth/store.ts tests/paths.test.ts tests/auth/store.test.ts
git commit -m "feat: add private credential store and path resolution"
```

---

### Task 4: PKCE and the Cloudflare OAuth flow

**Files:**
- Create: `src/auth/pkce.ts`, `src/auth/cloudflare-oauth.ts`
- Test: `tests/auth/pkce.test.ts`, `tests/auth/cloudflare-oauth.test.ts`

**Interfaces:**
- Consumes: `FetchFn` and `ApiError` (Task 2), and `CredentialStore` (Task 3).
- Produces:
  - `challengeFor(verifier: string): string`, `createPkcePair(): { verifier: string; challenge: string }` and `randomToken(bytes?: number): string`
  - `CF_AUTHORIZE_URL`, `CF_TOKEN_URL`
  - `interface TokenSet { accessToken: string; refreshToken?: string; expiresAt: number }`
  - `buildAuthorizeUrl(p: { clientId: string; redirectUri: string; scopes: readonly string[]; state: string; challenge: string }): string`
  - `exchangeCode(fetch, p: { clientId; redirectUri; code; verifier }, now?): Promise<TokenSet>`
  - `refreshTokens(fetch, p: { clientId; refreshToken }, now?): Promise<TokenSet>`
  - `createCloudflareTokenProvider(o: { store; fetch; clientId; now? }): () => Promise<string>`
  - `interface PendingAuthStore { create(): { state: string; challenge: string }; take(state: string): string | null }` and `createPendingAuthStore(ttlMs?, now?)`

- [ ] **Step 1: Write the failing tests**

`tests/auth/pkce.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { challengeFor, createPkcePair, randomToken } from "../../src/auth/pkce.ts";

describe("pkce", () => {
  it("matches the RFC 7636 appendix B example", () => {
    expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("creates a verifier of at least 43 URL-safe characters with a matching challenge", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(challengeFor(verifier));
  });

  it("creates distinct random tokens", () => {
    expect(randomToken()).not.toBe(randomToken());
  });
});
```

`tests/auth/cloudflare-oauth.test.ts`:

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  createCloudflareTokenProvider,
  createPendingAuthStore,
  exchangeCode,
} from "../../src/auth/cloudflare-oauth.ts";
import { createCredentialStore } from "../../src/auth/store.ts";
import { isAuthError } from "../../src/http.ts";
import { fakeFetch, json } from "../helpers/fake-fetch.ts";
import { makeTempDir } from "../helpers/tmp.ts";

describe("buildAuthorizeUrl", () => {
  it("includes PKCE S256, state and space-separated scopes", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "cid",
        redirectUri: "http://localhost:4417/auth/cloudflare/callback",
        scopes: ["user-details.read", "workers-scripts.write"],
        state: "st",
        challenge: "ch",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "cid",
      redirect_uri: "http://localhost:4417/auth/cloudflare/callback",
      scope: "user-details.read workers-scripts.write",
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
    });
  });
});

describe("exchangeCode", () => {
  it("posts a form body and returns a token set with an absolute expiry", async () => {
    const f = fakeFetch([json({ access_token: "at", refresh_token: "rt", expires_in: 3600 })]);
    const t = await exchangeCode(f.fetch, { clientId: "cid", redirectUri: "r", code: "c", verifier: "v" }, 1_000);
    expect(t).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: 1_000 + 3_600_000 });
    expect(f.calls[0]?.url).toBe("https://dash.cloudflare.com/oauth2/token");
    expect(String(f.calls[0]?.init?.body)).toBe(
      "grant_type=authorization_code&code=c&redirect_uri=r&client_id=cid&code_verifier=v",
    );
  });

  it("surfaces the OAuth error description", async () => {
    const f = fakeFetch([json({ error: "invalid_grant", error_description: "Code expired" }, 400)]);
    await expect(
      exchangeCode(f.fetch, { clientId: "c", redirectUri: "r", code: "c", verifier: "v" }),
    ).rejects.toThrow("Code expired");
  });
});

describe("createCloudflareTokenProvider", () => {
  async function setup(expiresAt: number, responses: Parameters<typeof fakeFetch>[0] = []) {
    const dir = await makeTempDir();
    const store = createCredentialStore(join(dir, "credentials.json"));
    await store.update(() => ({ cloudflare: { accessToken: "old", refreshToken: "r1", expiresAt } }));
    const f = fakeFetch(responses);
    const provider = createCloudflareTokenProvider({ store, fetch: f.fetch, clientId: "cid", now: () => 10_000 });
    return { store, provider, calls: f.calls };
  }

  it("returns the stored token while it has more than a minute left", async () => {
    const { provider, calls } = await setup(10_000 + 120_000);
    expect(await provider()).toBe("old");
    expect(calls).toHaveLength(0);
  });

  it("refreshes near expiry, persists the new tokens, and refreshes once for concurrent callers", async () => {
    const { provider, store, calls } = await setup(10_000 + 30_000, [
      json({ access_token: "new", refresh_token: "r2", expires_in: 3600 }),
    ]);
    const [a, b] = await Promise.all([provider(), provider()]);
    expect([a, b]).toEqual(["new", "new"]);
    expect(calls).toHaveLength(1);
    expect((await store.read()).cloudflare).toMatchObject({ accessToken: "new", refreshToken: "r2" });
  });

  it("keeps the old refresh token if the response omits one", async () => {
    const { provider, store } = await setup(0, [json({ access_token: "new", expires_in: 3600 })]);
    await provider();
    expect((await store.read()).cloudflare?.refreshToken).toBe("r1");
  });

  it("throws an auth error when Cloudflare is not connected", async () => {
    const dir = await makeTempDir();
    const provider = createCloudflareTokenProvider({
      store: createCredentialStore(join(dir, "c.json")),
      fetch: fakeFetch([]).fetch,
      clientId: "cid",
    });
    expect(isAuthError(await provider().catch((e: unknown) => e))).toBe(true);
  });
});

describe("createPendingAuthStore", () => {
  it("returns the verifier once per state", () => {
    const pending = createPendingAuthStore();
    const { state } = pending.create();
    expect(pending.take(state)).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(pending.take(state)).toBeNull();
  });

  it("expires old flows", () => {
    let now = 0;
    const pending = createPendingAuthStore(1000, () => now);
    const { state } = pending.create();
    now = 1001;
    expect(pending.take(state)).toBeNull();
  });

  it("returns null for unknown states", () => {
    expect(createPendingAuthStore().take("nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/auth`
Expected: FAIL, because the modules `pkce.ts` and `cloudflare-oauth.ts` don't exist yet.

- [ ] **Step 3: Implement the modules**

`src/auth/pkce.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";

export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: challengeFor(verifier) };
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}
```

`src/auth/cloudflare-oauth.ts`:

```ts
import { ApiError, type FetchFn } from "../http.ts";
import { challengeFor, createPkcePair, randomToken } from "./pkce.ts";
import type { CredentialStore } from "./store.ts";

export const CF_AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
export const CF_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export function buildAuthorizeUrl(p: {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  challenge: string;
}): string {
  const url = new URL(CF_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: p.scopes.join(" "),
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

async function tokenRequest(fetch: FetchFn, params: Record<string, string>, now: number): Promise<TokenSet> {
  const res = await fetch(CF_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(await res.text()) as Record<string, unknown>;
  } catch {
    // Leave body empty; the status code is reported below.
  }
  if (!res.ok || typeof body.access_token !== "string") {
    const detail =
      typeof body.error_description === "string"
        ? body.error_description
        : typeof body.error === "string"
          ? body.error
          : `HTTP ${res.status}`;
    throw new ApiError("cloudflare", res.status, `OAuth token request failed: ${detail}`, res.status === 400 || res.status === 401);
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    expiresAt: now + expiresIn * 1000,
  };
}

export function exchangeCode(
  fetch: FetchFn,
  p: { clientId: string; redirectUri: string; code: string; verifier: string },
  now = Date.now(),
): Promise<TokenSet> {
  return tokenRequest(
    fetch,
    {
      grant_type: "authorization_code",
      code: p.code,
      redirect_uri: p.redirectUri,
      client_id: p.clientId,
      code_verifier: p.verifier,
    },
    now,
  );
}

export function refreshTokens(
  fetch: FetchFn,
  p: { clientId: string; refreshToken: string },
  now = Date.now(),
): Promise<TokenSet> {
  return tokenRequest(fetch, { grant_type: "refresh_token", refresh_token: p.refreshToken, client_id: p.clientId }, now);
}

export function createCloudflareTokenProvider(o: {
  store: CredentialStore;
  fetch: FetchFn;
  clientId: string;
  now?: () => number;
}): () => Promise<string> {
  const now = o.now ?? Date.now;
  let refreshing: Promise<string> | null = null;

  return async () => {
    const { cloudflare } = await o.store.read();
    if (!cloudflare) throw new ApiError("cloudflare", 401, "Cloudflare is not connected", true);
    if (cloudflare.expiresAt - now() > 60_000) return cloudflare.accessToken;
    const refreshToken = cloudflare.refreshToken;
    if (!refreshToken) throw new ApiError("cloudflare", 401, "The Cloudflare session has expired", true);

    refreshing ??= (async () => {
      try {
        const t = await refreshTokens(o.fetch, { clientId: o.clientId, refreshToken }, now());
        await o.store.update((c) => ({
          ...c,
          cloudflare: {
            ...(c.cloudflare ?? cloudflare),
            accessToken: t.accessToken,
            expiresAt: t.expiresAt,
            refreshToken: t.refreshToken ?? refreshToken,
          },
        }));
        return t.accessToken;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  };
}

export interface PendingAuthStore {
  create(): { state: string; challenge: string };
  take(state: string): string | null;
}

export function createPendingAuthStore(ttlMs = 10 * 60_000, now: () => number = Date.now): PendingAuthStore {
  const pending = new Map<string, { verifier: string; createdAt: number }>();
  return {
    create() {
      const state = randomToken();
      const { verifier } = createPkcePair();
      pending.set(state, { verifier, createdAt: now() });
      return { state, challenge: challengeFor(verifier) };
    },
    take(state) {
      const entry = pending.get(state);
      pending.delete(state);
      if (!entry || now() - entry.createdAt > ttlMs) return null;
      return entry.verifier;
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/auth && pnpm typecheck`
Expected: all the `tests/auth` tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/auth tests/auth
git commit -m "feat: add Cloudflare OAuth with PKCE and token refresh"
```

---

### Task 5: Create the Cloudflare OAuth client and `src/config.ts`

This task makes an **external change** to the maintainer's Cloudflare account. Get explicit confirmation before Step 3.

**Files:**
- Create: `src/config.ts`, `tests/config.test.ts`

**Interfaces:**
- Produces: `PORT`, `ORIGIN`, `CLOUDFLARE_REDIRECT_URI`, `CLOUDFLARE_CLIENT_ID`, `CLOUDFLARE_SCOPES`, `MIGRATION_BRANCH`, `VINEXT_VERSION`, `PRODUCTION_TRIGGER`, `PREVIEW_TRIGGER` and `GITHUB_APP_INSTALL_URL`.

- [ ] **Step 1: Ask which account will own the client**

Run `cf auth whoami`. This machine is logged in to two accounts (`498b0923…` "cf free" and `240e3401…` "Mattietk@gmail.com's Account"). Ask the user which one should own the Switchyard OAuth client, and wait for the answer.

- [ ] **Step 2: Dry-run the creation**

```bash
CLOUDFLARE_ACCOUNT_ID=<chosen account id> cf oauth-clients create --dry-run \
  --client-name "Switchyard (local)" \
  --grant-types authorization_code refresh_token \
  --response-types code \
  --token-endpoint-auth-method none \
  --redirect-uris http://localhost:4417/auth/cloudflare/callback \
  --scopes user-details.read memberships.read account-settings.read workers-scripts.write workers-ci.write workers-kv-storage.write workers-r2.write d1.write zone.read dns.read workers-routes.write
```

Expected: the command prints the request it would send, with no error. If `cf` rejects `CLOUDFLARE_ACCOUNT_ID`, run `cf oauth-clients create --help` and pass the account the way it describes.

These scopes cover every plan, so the client never needs re-consent later. Zone, DNS and routes are for plan 3's cut-over. KV, R2 and D1 cover vinext's KV cache and plan 3's storage moves.

- [ ] **Step 3: Create the client (after confirmation)**

Show the user the dry-run output and ask them to confirm. Then run the same command without `--dry-run`. Record the `client_id` from the output; there is no secret, because this is a public PKCE client.

Verify the result with `CLOUDFLARE_ACCOUNT_ID=<id> cf oauth-clients get <client_id>`. The output should list the redirect URI and the scopes.

- [ ] **Step 4: Write the config test**

`tests/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import * as config from "../src/config.ts";

describe("config", () => {
  it("registers a redirect URI on the fixed port", () => {
    expect(config.CLOUDFLARE_REDIRECT_URI).toBe(`http://localhost:${config.PORT}/auth/cloudflare/callback`);
  });

  it("has a real client ID", () => {
    expect(config.CLOUDFLARE_CLIENT_ID).toMatch(/^[A-Za-z0-9_-]{8,}$/);
  });

  it("uses dot-delimited scopes only (Cloudflare rejects colon-delimited ones)", () => {
    for (const s of config.CLOUDFLARE_SCOPES) expect(s).toMatch(/^[a-z0-9_-]+\.[a-z_]+$/);
  });

  it("never uses a common production branch name for the migration branch", () => {
    expect(["main", "master", "production"]).not.toContain(config.MIGRATION_BRANCH);
  });
});
```

- [ ] **Step 5: Write `src/config.ts`**

Use the `client_id` recorded in Step 3:

```ts
export const PORT = 4417;
export const ORIGIN = `http://localhost:${PORT}`;
export const CLOUDFLARE_REDIRECT_URI = `${ORIGIN}/auth/cloudflare/callback`;

// Public PKCE client registered on the maintainer's Cloudflare account (no secret).
export const CLOUDFLARE_CLIENT_ID = "<client_id recorded in Task 5 Step 3>";

export const CLOUDFLARE_SCOPES = [
  "user-details.read",
  "memberships.read",
  "account-settings.read",
  "workers-scripts.write",
  "workers-ci.write",
  "workers-kv-storage.write",
  "workers-r2.write",
  "d1.write",
  "zone.read",
  "dns.read",
  "workers-routes.write",
] as const;

export const MIGRATION_BRANCH = "cloudflare-migration";
export const VINEXT_VERSION = "1.1.0";
export const PRODUCTION_TRIGGER = "switchyard-production";
export const PREVIEW_TRIGGER = "switchyard-preview";
export const GITHUB_APP_INSTALL_URL = "https://github.com/apps/cloudflare-workers-and-pages/installations/new";
```

- [ ] **Step 6: Run the tests**

Run: `pnpm test tests/config.test.ts && pnpm typecheck`
Expected: 4 tests pass. If the client-ID test fails, the placeholder wasn't replaced.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add Switchyard OAuth client and project constants"
```

---

### Task 6: Spikes

Run these before building anything that depends on them, and record the results in `docs/spikes.md`. Several steps create Cloudflare and GitHub resources, so get the user's confirmation before each step marked **(external)**.

**Files:**
- Create: `scripts/spike-login.ts`, `docs/spikes.md`

- [ ] **Step 1: Write a throwaway login script**

`scripts/spike-login.ts` reuses Task 4's modules to get a real OAuth token into a scratch credentials store:

```ts
// Spike helper: run with SWITCHYARD_HOME=/some/scratch node scripts/spike-login.ts
import { createServer } from "node:http";
import { buildAuthorizeUrl, createPendingAuthStore, exchangeCode } from "../src/auth/cloudflare-oauth.ts";
import { createCredentialStore } from "../src/auth/store.ts";
import { CLOUDFLARE_CLIENT_ID, CLOUDFLARE_REDIRECT_URI, CLOUDFLARE_SCOPES, PORT } from "../src/config.ts";
import { resolvePaths } from "../src/paths.ts";

const store = createCredentialStore(resolvePaths().credentialsFile);
const pending = createPendingAuthStore();
const { state, challenge } = pending.create();
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/auth/cloudflare/callback") return res.writeHead(404).end();
  const verifier = pending.take(url.searchParams.get("state") ?? "");
  const code = url.searchParams.get("code");
  if (!verifier || !code) return res.writeHead(400).end(`Login failed: ${url.searchParams.get("error_description") ?? "bad state"}`);
  const t = await exchangeCode(fetch, { clientId: CLOUDFLARE_CLIENT_ID, redirectUri: CLOUDFLARE_REDIRECT_URI, code, verifier });
  await store.update((c) => ({ ...c, cloudflare: t }));
  res.end("Logged in. You can close this tab.");
  console.log(`Token stored; expires ${new Date(t.expiresAt).toISOString()}; refresh token: ${t.refreshToken ? "yes" : "no"}`);
  server.close();
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(buildAuthorizeUrl({ clientId: CLOUDFLARE_CLIENT_ID, redirectUri: CLOUDFLARE_REDIRECT_URI, scopes: CLOUDFLARE_SCOPES, state, challenge }));
});
```

Run it:

```bash
export SPIKE=~/.cache/switchyard-spike && mkdir -p $SPIKE
SWITCHYARD_HOME=$SPIKE node scripts/spike-login.ts
```

Open the printed URL and approve. Then define a helper for the remaining steps:

```bash
export CF_TOKEN=$(node -e 'console.log(require(process.argv[1]).cloudflare.accessToken)' $SPIKE/config/credentials.json)
export CF_ACCOUNT=<account id the user picked>
```

Record whether a refresh token came back, and how long the access token lasts.

- [ ] **Step 2: Check the token with the plain API, and the Builds API (spike 5)**

```bash
curl -s -H "Authorization: Bearer $CF_TOKEN" https://api.cloudflare.com/client/v4/user | head -c 300; echo
curl -s -H "Authorization: Bearer $CF_TOKEN" "https://api.cloudflare.com/client/v4/accounts?per_page=50" | head -c 300; echo
curl -s -H "Authorization: Bearer $CF_TOKEN" https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/builds/tokens | head -c 500; echo
```

Expected: all three calls return `"success":true`.

If the Builds call returns "Invalid token" (spike 5 fails), stop and tell the user. The fallback is a user-scoped API token field on the Cloudflare card, used only by the `builds` step, and Tasks 9, 20 and 22 would change.

- [ ] **Step 3: Deploy a vinext app with the OAuth token (spikes 1 and 3) (external)**

This creates a Worker called `switchyard-spike` on the chosen account. Confirm with the user first.

```bash
cd $SPIKE && rm -rf app && mkdir -p app/app/api/cron && cd app
cat > package.json <<'EOF'
{ "name": "switchyard-spike", "private": true, "scripts": { "build": "next build" },
  "dependencies": { "next": "16.0.0", "react": "19.2.0", "react-dom": "19.2.0" } }
EOF
printf 'export default function L({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n' > app/layout.tsx
printf 'import { env } from "cloudflare:workers";\nexport const dynamic = "force-dynamic";\nexport default function P() { return <h1>secret length {String((env as Record<string, string>).SPIKE_SECRET ?? "").length}</h1>; }\n' > app/page.tsx
printf 'export async function GET(req: Request) { console.log("cron hit", req.headers.get("authorization")); return Response.json({ ok: true }); }\n' > app/api/cron/route.ts
git init -q && git add -A && git commit -qm init
pnpm dlx vinext@1.1.0 init --platform=cloudflare --cdn-cache=data-cache --data-cache=kv --image-optimization=cloudflare-images
```

Edit `cloudflare.config.ts` by hand: add `SPIKE_SECRET: bindings.secret(),` to `env`. Then deploy:

```bash
echo '{"SPIKE_SECRET":"spike-value-123"}' > ../secrets.json && chmod 600 ../secrets.json
CI=1 CLOUDFLARE_API_TOKEN=$CF_TOKEN CLOUDFLARE_ACCOUNT_ID=$CF_ACCOUNT pnpm exec cf deploy --secrets-file ../secrets.json
```

Record whether the deploy succeeds with the OAuth token (spike 1), and the `workers.dev` URL it prints. Then `curl` that URL and check the page shows "secret length 15".

Next, deploy again **without** `--secrets-file` and `curl` the URL again. Record whether it still shows 15 (spike 3).

- If spike 1 fails, stop. The fallback changes Task 19's `deployStep`, which would create the Worker by uploading the `cf build` output through the API.
- If spike 3 fails (the secret is gone after the second deploy), stop. The fallback adds the runtime secrets as trigger build variables, and the production trigger's deploy command would write them to a file and pass `--secrets-file`. That changes Task 20.

- [ ] **Step 4: Check the cron wrapper at runtime (spike 6)**

In `$SPIKE/app`, write `switchyard-entry.ts` exactly as Task 14's `cronEntrySource("vinext/server/fetch-handler", [{ path: "/api/cron", schedule: "* * * * *" }])` would produce it (copy the template from Task 14). In the config, set `entrypoint: "./switchyard-entry.ts"` and `triggers: [triggers.scheduled({ schedule: "* * * * *" })]`, and import `triggers`. Then:

```bash
pnpm exec cf dev &
sleep 15
curl -s "http://localhost:5173/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"
kill %1
```

Expected: the dev server log shows `cron hit`.

If the scheduled handler can't reach the route, record the error and stop. Task 14's template would then need to change.

- [ ] **Step 5: Check Workers Builds running `cf` (spike 2) (external)**

This creates a private GitHub repo `switchyard-spike`, a repo connection and two triggers. Confirm with the user first.

1. Create and push the repo:

   ```bash
   cd $SPIKE/app && gh repo create switchyard-spike --private --source . --push
   ```

2. Install the Cloudflare GitHub App on the repo if it isn't installed: open `https://github.com/apps/cloudflare-workers-and-pages/installations/new` and select the repo. Record whether that URL works.
3. Through the API with `$CF_TOKEN`, do the following, recording each response body:
   1. `PUT /accounts/$CF_ACCOUNT/builds/repos/connections`
   2. `GET /accounts/$CF_ACCOUNT/workers/scripts`, to find the `tag` of `switchyard-spike`
   3. `GET .../builds/tokens`
   4. `POST .../builds/triggers`, with build command `pnpm exec cf build`, deploy command `pnpm exec cf deploy --prebuilt`, `branch_includes: ["main"]` and `path_includes: ["*"]`

   Body shapes are in Task 9.
4. Start a build with `POST .../builds/triggers/<uuid>/builds {"branch":"main"}`. Then poll `GET .../builds/builds/<build_uuid>` every 10 seconds until it finishes. Record:
   - the exact `status` and `build_outcome` values seen while running and at the end (needed by Task 20's `interpretBuild`);
   - whether `cf deploy --prebuilt` succeeded with the injected build token;
   - the dashboard URL of the build page (needed by `buildDashboardUrl`).
5. Run `pnpm exec cf deploy --help` and `cf cli search "upload preview version"`, and record any `cf` command that uploads a version without deploying it. If one exists, plan 2 or a follow-up can turn on real preview deploys.

If `cf deploy --prebuilt` fails inside Workers Builds, stop. The fallback is a deploy command of `pnpm exec cf deploy`, and if that also fails, `npx wrangler deploy`. Update `PRODUCTION_TRIGGER` commands in Task 20 to match.

- [ ] **Step 6: Check Vercel token reach (spike 4)**

Ask the user to create a team-scoped token following the spec's guide and export it as `VERCEL_TOKEN`, without pasting it into chat. Then run:

```bash
for p in /v2/user /v2/teams "/v9/projects?limit=5"; do echo "== $p"; curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $VERCEL_TOKEN" "https://api.vercel.com$p"; done
curl -s -H "Authorization: Bearer $VERCEL_TOKEN" "https://api.vercel.com/v10/projects/<a project id>/env?decrypt=true" | node -e 'const e=JSON.parse(require("fs").readFileSync(0)).envs; console.log(e.map(v=>({key:v.key,type:v.type,target:v.target,hasValue:typeof v.value==="string"})))'
```

Record:
- which endpoints return 200 for a team token;
- whether `plain` and `encrypted` values come back;
- what `sensitive` vars look like.

If `/v2/user` returns 200 for a team token, update `inferTokenScope` in Task 13: a team token can then be recognised because `/v2/teams` returns exactly the token's team. Write down the exact rule.

- [ ] **Step 7: Write up the results**

Create `docs/spikes.md` with one section per spike. Each section gives the question, the commands run, the observed result (with the exact field values) and the decision ("keep the plan" or "apply fallback X to Task N").

Ask the user whether to delete the spike Worker, repo and triggers now or keep them for the end-to-end run in Task 28.

- [ ] **Step 8: Commit**

```bash
git add scripts/spike-login.ts docs/spikes.md
git commit -m "docs: record spike results for cf, Workers Builds and Vercel tokens"
```

If any spike changed a later task, edit that task in this plan file in the same commit.

---

### Task 7: Command runner and GitHub auth

**Files:**
- Create: `src/exec.ts`, `src/auth/github.ts`, `tests/helpers/fake-runner.ts`
- Test: `tests/exec.test.ts`, `tests/auth/github.test.ts`

**Interfaces:**
- Consumes: `CredentialStore` (Task 3).
- Produces:
  - `interface RunOptions { cwd?: string; env?: Record<string, string>; onLine?: (line: string) => void; timeoutMs?: number }`
  - `interface RunResult { code: number; output: string }` (stdout and stderr interleaved, ANSI stripped)
  - `type CommandRunner = (cmd: string, args: readonly string[], opts?: RunOptions) => Promise<RunResult>`
  - `class CommandError extends Error { code: number; output: string }`
  - `createCommandRunner(): CommandRunner` and `runOrThrow(run, cmd, args, opts?): Promise<RunResult>`
  - `interface GitHubAuth { token: string; source: "gh" | "pat" }`, `resolveGitHubAuth(run, store): Promise<GitHubAuth | null>` and `gitAuthEnv(token: string): Record<string, string>`
  - test helper `fakeRunner(handler)` returning `{ run, calls }`

- [ ] **Step 1: Write the fake runner helper**

`tests/helpers/fake-runner.ts`:

```ts
import type { CommandRunner, RunOptions, RunResult } from "../../src/exec.ts";

export interface RunCall {
  cmd: string;
  args: string[];
  opts: RunOptions | undefined;
}

export function fakeRunner(
  handler: (cmd: string, args: readonly string[], opts?: RunOptions) => RunResult | Promise<RunResult> = () => ({
    code: 0,
    output: "",
  }),
): { run: CommandRunner; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run: CommandRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], opts });
    const result = await handler(cmd, args, opts);
    for (const line of result.output.split("\n")) if (line) opts?.onLine?.(line);
    return result;
  };
  return { run, calls };
}
```

- [ ] **Step 2: Write the failing tests**

`tests/exec.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CommandError, createCommandRunner, runOrThrow } from "../src/exec.ts";

const run = createCommandRunner();
const node = process.execPath;

describe("createCommandRunner", () => {
  it("captures stdout and stderr and reports lines as they arrive", async () => {
    const lines: string[] = [];
    const r = await run(node, ["-e", "console.log('a'); console.error('b'); process.stdout.write('c')"], {
      onLine: (l) => lines.push(l),
    });
    expect(r.code).toBe(0);
    expect(r.output).toContain("a");
    expect(r.output).toContain("b");
    expect(lines).toEqual(expect.arrayContaining(["a", "b", "c"]));
  });

  it("returns the exit code without throwing", async () => {
    expect((await run(node, ["-e", "process.exit(3)"])).code).toBe(3);
  });

  it("passes extra env and cwd", async () => {
    const r = await run(node, ["-e", "console.log(process.env.SY_X + ':' + process.cwd())"], {
      env: { SY_X: "hello" },
      cwd: "/",
    });
    expect(r.output.trim()).toBe("hello:/");
  });

  it("strips ANSI colour codes from lines", async () => {
    const lines: string[] = [];
    await run(node, ["-e", "console.log('\\u001b[33mwarn\\u001b[0m')"], { onLine: (l) => lines.push(l) });
    expect(lines).toEqual(["warn"]);
  });

  it("rejects when the command does not exist", async () => {
    await expect(run("definitely-not-a-command-sy", [])).rejects.toThrow(/ENOENT/);
  });

  it("kills the process after the timeout", async () => {
    const r = await run(node, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 200 });
    expect(r.code).not.toBe(0);
  });
});

describe("runOrThrow", () => {
  it("throws CommandError with the output on a non-zero exit", async () => {
    const err = await runOrThrow(run, node, ["-e", "console.log('boom'); process.exit(2)"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect((err as CommandError).code).toBe(2);
    expect((err as CommandError).output).toContain("boom");
  });
});
```

`tests/auth/github.test.ts`:

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitAuthEnv, resolveGitHubAuth } from "../../src/auth/github.ts";
import { createCredentialStore } from "../../src/auth/store.ts";
import { fakeRunner } from "../helpers/fake-runner.ts";
import { makeTempDir } from "../helpers/tmp.ts";

async function store(pat?: string) {
  const s = createCredentialStore(join(await makeTempDir(), "c.json"));
  if (pat) await s.update((c) => ({ ...c, githubPat: pat }));
  return s;
}

describe("resolveGitHubAuth", () => {
  it("prefers the gh login", async () => {
    const { run, calls } = fakeRunner(() => ({ code: 0, output: "gho_abc\n" }));
    expect(await resolveGitHubAuth(run, await store("ghp_pat"))).toEqual({ token: "gho_abc", source: "gh" });
    expect(calls[0]).toMatchObject({ cmd: "gh", args: ["auth", "token"] });
  });

  it("falls back to the stored PAT when gh is logged out", async () => {
    const { run } = fakeRunner(() => ({ code: 1, output: "not logged in" }));
    expect(await resolveGitHubAuth(run, await store("ghp_pat"))).toEqual({ token: "ghp_pat", source: "pat" });
  });

  it("falls back to the stored PAT when gh is not installed", async () => {
    const run = async () => {
      throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    };
    expect(await resolveGitHubAuth(run, await store("ghp_pat"))).toEqual({ token: "ghp_pat", source: "pat" });
  });

  it("returns null when neither is available", async () => {
    const { run } = fakeRunner(() => ({ code: 1, output: "" }));
    expect(await resolveGitHubAuth(run, await store())).toBeNull();
  });
});

describe("gitAuthEnv", () => {
  it("passes the token as an HTTP header through env-only git config", () => {
    const env = gitAuthEnv("tok");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${Buffer.from("x-access-token:tok").toString("base64")}`);
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test tests/exec.test.ts tests/auth/github.test.ts`
Expected: FAIL, because the modules can't be resolved.

- [ ] **Step 4: Implement the modules**

`src/exec.ts`:

```ts
import { spawn } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  onLine?: (line: string) => void;
  timeoutMs?: number;
}

export interface RunResult {
  code: number;
  output: string;
}

export type CommandRunner = (cmd: string, args: readonly string[], opts?: RunOptions) => Promise<RunResult>;

export class CommandError extends Error {
  readonly code: number;
  readonly output: string;

  constructor(cmd: string, args: readonly string[], result: RunResult) {
    super(`${[cmd, ...args].join(" ")} exited with code ${result.code}`);
    this.name = "CommandError";
    this.code = result.code;
    this.output = result.output;
  }
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

// Runs a command without a shell, so arguments are never interpreted.
export function createCommandRunner(): CommandRunner {
  return (cmd, args, opts = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...opts.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let partial = "";
      const emit = (line: string) => opts.onLine?.(line.replace(ANSI, ""));
      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        output += text;
        partial += text;
        const lines = partial.split(/\r?\n/);
        partial = lines.pop() ?? "";
        for (const line of lines) emit(line);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs) : undefined;
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (partial) emit(partial);
        resolve({ code: code ?? (signal ? 128 : 1), output: output.replace(ANSI, "") });
      });
    });
}

export async function runOrThrow(
  run: CommandRunner,
  cmd: string,
  args: readonly string[],
  opts?: RunOptions,
): Promise<RunResult> {
  const result = await run(cmd, args, opts);
  if (result.code !== 0) throw new CommandError(cmd, args, result);
  return result;
}
```

`src/auth/github.ts`:

```ts
import type { CommandRunner } from "../exec.ts";
import type { CredentialStore } from "./store.ts";

export interface GitHubAuth {
  token: string;
  source: "gh" | "pat";
}

export async function resolveGitHubAuth(run: CommandRunner, store: CredentialStore): Promise<GitHubAuth | null> {
  try {
    const r = await run("gh", ["auth", "token"]);
    const token = r.output.trim();
    if (r.code === 0 && token) return { token, source: "gh" };
  } catch {
    // gh is not installed; fall through to the stored PAT.
  }
  const { githubPat } = await store.read();
  return githubPat ? { token: githubPat, source: "pat" } : null;
}

// Supplies the token to git as an HTTP header through environment-only config,
// so it never lands in .git/config, the remote URL or the process arguments.
export function gitAuthEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test tests/exec.test.ts tests/auth/github.test.ts && pnpm typecheck`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/exec.ts src/auth/github.ts tests/exec.test.ts tests/auth/github.test.ts tests/helpers/fake-runner.ts
git commit -m "feat: add shell-free command runner and gh-first GitHub auth"
```

---

### Task 8: Vercel client

**Files:**
- Create: `src/clients/vercel.ts`
- Test: `tests/clients/vercel.test.ts`

**Interfaces:**
- Consumes: `createJsonClient`, `FetchFn`, `ApiError` and `isAuthError` (Task 2).
- Produces:
  - `type VercelTarget = "production" | "preview" | "development"`
  - `interface VercelUser { id: string; username: string; email?: string }`
  - `interface VercelTeam { id: string; slug: string; name: string }`
  - `interface VercelProject { id: string; name: string; framework: string | null; rootDirectory: string | null; link?: { type: string; org?: string; repo?: string; repoId?: number; productionBranch?: string } }`
  - `interface VercelEnvVar { id: string; key: string; value?: string; type: "plain" | "encrypted" | "sensitive" | "secret" | "system"; target: VercelTarget[]; gitBranch?: string | null }`
  - `interface VercelDomain { name: string; redirect?: string | null; gitBranch?: string | null }`
  - `interface VercelClient { getUser(); listTeams(); listProjects(); getProject(id); listEnv(projectId); listDomains(projectId) }`
  - `createVercelClient(o: { fetch: FetchFn; token: string; teamId?: string }): VercelClient`
  - `interface ScopeProbe { userOk: boolean; user: VercelUser | null; teams: VercelTeam[] | null; projectsOk: boolean }` and `probeVercelToken(c: VercelClient): Promise<ScopeProbe>`

- [ ] **Step 1: Write the failing tests**

`tests/clients/vercel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createVercelClient, probeVercelToken } from "../../src/clients/vercel.ts";
import { isAuthError } from "../../src/http.ts";
import { fakeFetch, json } from "../helpers/fake-fetch.ts";

describe("createVercelClient", () => {
  it("pages through projects with `until` and adds teamId", async () => {
    const f = fakeFetch([
      json({ projects: [{ id: "p1", name: "a" }], pagination: { next: 1700 } }),
      json({ projects: [{ id: "p2", name: "b" }], pagination: { next: null } }),
    ]);
    const c = createVercelClient({ fetch: f.fetch, token: "t", teamId: "team_1" });
    expect((await c.listProjects()).map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(f.calls[0]?.url).toBe("https://api.vercel.com/v9/projects?teamId=team_1&limit=100");
    expect(f.calls[1]?.url).toBe("https://api.vercel.com/v9/projects?teamId=team_1&limit=100&until=1700");
  });

  it("requests decrypted env vars", async () => {
    const f = fakeFetch([json({ envs: [{ id: "e1", key: "A", value: "1", type: "plain", target: ["production"] }] })]);
    const envs = await createVercelClient({ fetch: f.fetch, token: "t" }).listEnv("p 1");
    expect(envs[0]?.key).toBe("A");
    expect(f.calls[0]?.url).toBe("https://api.vercel.com/v10/projects/p%201/env?decrypt=true");
  });

  it("lists domains and gets one project", async () => {
    const f = fakeFetch([json({ domains: [{ name: "example.com" }] }), json({ id: "p1", name: "a", framework: "nextjs" })]);
    const c = createVercelClient({ fetch: f.fetch, token: "t" });
    expect(await c.listDomains("p1")).toEqual([{ name: "example.com" }]);
    expect((await c.getProject("p1")).framework).toBe("nextjs");
  });

  it("treats invalidToken 403 as an auth error", async () => {
    const f = fakeFetch([json({ error: { code: "forbidden", message: "Not authorized", invalidToken: true } }, 403)]);
    const err = await createVercelClient({ fetch: f.fetch, token: "bad" }).getUser().catch((e: unknown) => e);
    expect(isAuthError(err)).toBe(true);
  });
});

describe("probeVercelToken", () => {
  it("records which calls succeed", async () => {
    const f = fakeFetch([
      json({ error: { message: "forbidden for this scope" } }, 403),
      json({ error: { message: "forbidden for this scope" } }, 403),
      json({ projects: [], pagination: { next: null } }),
    ]);
    const probe = await probeVercelToken(createVercelClient({ fetch: f.fetch, token: "t" }));
    expect(probe).toEqual({ userOk: false, user: null, teams: null, projectsOk: true });
  });

  it("returns user and teams for a full-account token", async () => {
    const f = fakeFetch([
      json({ user: { id: "u", username: "matt" } }),
      json({ teams: [{ id: "team_1", slug: "acme", name: "Acme" }] }),
      json({ projects: [], pagination: { next: null } }),
    ]);
    const probe = await probeVercelToken(createVercelClient({ fetch: f.fetch, token: "t" }));
    expect(probe.userOk).toBe(true);
    expect(probe.user?.username).toBe("matt");
    expect(probe.teams).toHaveLength(1);
  });

  it("rethrows auth errors so a rejected token is reported as such", async () => {
    const bad = json({ error: { invalidToken: true } }, 403);
    const f = fakeFetch([bad, bad.clone(), bad.clone()]);
    await expect(probeVercelToken(createVercelClient({ fetch: f.fetch, token: "t" }))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/clients/vercel.test.ts`
Expected: FAIL, because the module can't be resolved.

- [ ] **Step 3: Implement the client**

`src/clients/vercel.ts`:

```ts
import { createJsonClient, isAuthError, type FetchFn } from "../http.ts";

export type VercelTarget = "production" | "preview" | "development";

export interface VercelUser {
  id: string;
  username: string;
  email?: string;
}

export interface VercelTeam {
  id: string;
  slug: string;
  name: string;
}

export interface VercelProject {
  id: string;
  name: string;
  framework: string | null;
  rootDirectory: string | null;
  link?: { type: string; org?: string; repo?: string; repoId?: number; productionBranch?: string };
}

export interface VercelEnvVar {
  id: string;
  key: string;
  value?: string;
  type: "plain" | "encrypted" | "sensitive" | "secret" | "system";
  target: VercelTarget[];
  gitBranch?: string | null;
}

export interface VercelDomain {
  name: string;
  redirect?: string | null;
  gitBranch?: string | null;
}

export interface VercelClient {
  getUser(): Promise<VercelUser>;
  listTeams(): Promise<VercelTeam[]>;
  listProjects(): Promise<VercelProject[]>;
  getProject(idOrName: string): Promise<VercelProject>;
  listEnv(projectId: string): Promise<VercelEnvVar[]>;
  listDomains(projectId: string): Promise<VercelDomain[]>;
}

type Query = Record<string, string | number | undefined>;

export function createVercelClient(o: { fetch: FetchFn; token: string; teamId?: string }): VercelClient {
  const http = createJsonClient({
    service: "vercel",
    baseUrl: "https://api.vercel.com",
    fetch: o.fetch,
    token: async () => o.token,
    errorMessage: (b) => (b as { error?: { message?: string } } | null)?.error?.message,
    isAuthFailure: (status, b) =>
      status === 403 && (b as { error?: { invalidToken?: boolean } } | null)?.error?.invalidToken === true,
  });
  const q = (extra: Query = {}): Query => ({ teamId: o.teamId, ...extra });
  const id = encodeURIComponent;

  return {
    getUser: async () => (await http.request<{ user: VercelUser }>("/v2/user")).user,
    listTeams: async () => (await http.request<{ teams: VercelTeam[] }>("/v2/teams", { query: { limit: 100 } })).teams,
    async listProjects() {
      const all: VercelProject[] = [];
      let until: number | undefined;
      do {
        const page = await http.request<{ projects: VercelProject[]; pagination?: { next: number | null } }>(
          "/v9/projects",
          { query: q({ limit: 100, until }) },
        );
        all.push(...page.projects);
        until = page.pagination?.next ?? undefined;
      } while (until);
      return all;
    },
    getProject: (p) => http.request<VercelProject>(`/v9/projects/${id(p)}`, { query: q() }),
    listEnv: async (p) =>
      (await http.request<{ envs: VercelEnvVar[] }>(`/v10/projects/${id(p)}/env`, { query: q({ decrypt: "true" }) }))
        .envs,
    listDomains: async (p) =>
      (await http.request<{ domains: VercelDomain[] }>(`/v9/projects/${id(p)}/domains`, { query: q() })).domains,
  };
}

export interface ScopeProbe {
  userOk: boolean;
  user: VercelUser | null;
  teams: VercelTeam[] | null;
  projectsOk: boolean;
}

// Vercel doesn't document which endpoints each token scope can reach, so we
// try the three we need and record what works. A rejected token is rethrown.
export async function probeVercelToken(c: VercelClient): Promise<ScopeProbe> {
  const attempt = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      if (isAuthError(e)) throw e;
      return null;
    }
  };
  const user = await attempt(() => c.getUser());
  const teams = await attempt(() => c.listTeams());
  const projects = await attempt(() => c.listProjects());
  return { userOk: user !== null, user, teams, projectsOk: projects !== null };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/clients/vercel.test.ts && pnpm typecheck`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/clients/vercel.ts tests/clients/vercel.test.ts
git commit -m "feat: add Vercel API client with token scope probe"
```

---

### Task 9: Cloudflare client

**Files:**
- Create: `src/clients/cloudflare.ts`
- Test: `tests/clients/cloudflare.test.ts`

**Interfaces:**
- Consumes: `createJsonClient` and `FetchFn` (Task 2).
- Produces:
  - `interface CloudflareAccount { id: string; name: string }` and `interface CloudflareZone { id: string; name: string }`
  - `interface BuildToken { build_token_uuid: string; build_token_name: string }`
  - `interface RepoConnectionInput { provider_type: "github"; provider_account_id: string; provider_account_name: string; repo_id: string; repo_name: string }`
  - `interface TriggerInput { external_script_id: string; repo_connection_uuid: string; build_token_uuid: string; trigger_name: string; build_command: string; deploy_command: string; root_directory: string; branch_includes: string[]; branch_excludes: string[]; path_includes: string[]; path_excludes: string[]; build_caching_enabled: boolean }`
  - `interface BuildTrigger { trigger_uuid: string; trigger_name: string }`
  - `interface BuildInfo { build_uuid: string; status: string; build_outcome?: string | null }`
  - `interface CloudflareClient { getUser(); listAccounts(); listZones(accountId); getWorkerTag(accountId, name); listBuildTokens(accountId); putRepoConnection(accountId, input); listTriggers(accountId, workerTag); createTrigger(accountId, input); setTriggerEnv(accountId, triggerUuid, vars); startBuild(accountId, triggerUuid, branch); getBuild(accountId, buildUuid) }`
  - `createCloudflareClient(o: { fetch: FetchFn; token: () => Promise<string> }): CloudflareClient`

- [ ] **Step 1: Write the failing tests**

`tests/clients/cloudflare.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createCloudflareClient } from "../../src/clients/cloudflare.ts";
import { fakeFetch, json } from "../helpers/fake-fetch.ts";

const ok = (result: unknown, result_info?: unknown) => json({ success: true, errors: [], result, result_info });
const BASE = "https://api.cloudflare.com/client/v4";

function client(responses: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(responses);
  return { c: createCloudflareClient({ fetch: f.fetch, token: async () => "oauth-tok" }), calls: f.calls };
}

describe("createCloudflareClient", () => {
  it("pages through accounts", async () => {
    const { c, calls } = client([
      ok([{ id: "a1", name: "One" }], { page: 1, total_pages: 2 }),
      ok([{ id: "a2", name: "Two" }], { page: 2, total_pages: 2 }),
    ]);
    expect((await c.listAccounts()).map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(calls[1]?.url).toBe(`${BASE}/accounts?page=2&per_page=50`);
  });

  it("filters zones by account", async () => {
    const { c, calls } = client([ok([{ id: "z1", name: "example.com" }], { page: 1, total_pages: 1 })]);
    await c.listZones("acc");
    expect(calls[0]?.url).toBe(`${BASE}/zones?account.id=acc&page=1&per_page=50`);
  });

  it("finds a Worker's tag by name, or null", async () => {
    const { c } = client([ok([{ id: "other", tag: "t0" }, { id: "my-app", tag: "t1" }]), ok([])]);
    expect(await c.getWorkerTag("acc", "my-app")).toBe("t1");
    expect(await c.getWorkerTag("acc", "my-app")).toBeNull();
  });

  it("creates a repo connection and returns its UUID", async () => {
    const { c, calls } = client([ok({ repo_connection_uuid: "rc-1" })]);
    const uuid = await c.putRepoConnection("acc", {
      provider_type: "github",
      provider_account_id: "1",
      provider_account_name: "me",
      repo_id: "2",
      repo_name: "app",
    });
    expect(uuid).toBe("rc-1");
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(calls[0]?.url).toBe(`${BASE}/accounts/acc/builds/repos/connections`);
  });

  it("creates triggers, sets env and starts builds", async () => {
    const { c, calls } = client([
      ok({ trigger_uuid: "tr-1", trigger_name: "switchyard-production" }),
      ok(null),
      ok({ build_uuid: "b-1" }),
      ok({ build_uuid: "b-1", status: "running", build_outcome: null }),
    ]);
    const trigger = await c.createTrigger("acc", {
      external_script_id: "tag",
      repo_connection_uuid: "rc",
      build_token_uuid: "bt",
      trigger_name: "switchyard-production",
      build_command: "pnpm exec cf build",
      deploy_command: "pnpm exec cf deploy --prebuilt",
      root_directory: "/",
      branch_includes: ["main"],
      branch_excludes: [],
      path_includes: ["*"],
      path_excludes: [],
      build_caching_enabled: true,
    });
    expect(trigger.trigger_uuid).toBe("tr-1");
    await c.setTriggerEnv("acc", "tr-1", { A: { value: "1", is_secret: false } });
    expect(calls[1]?.init?.method).toBe("PATCH");
    expect(calls[1]?.url).toBe(`${BASE}/accounts/acc/builds/triggers/tr-1/environment_variables`);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ A: { value: "1", is_secret: false } });
    expect(await c.startBuild("acc", "tr-1", "cloudflare-migration")).toBe("b-1");
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ branch: "cloudflare-migration" });
    expect((await c.getBuild("acc", "b-1")).status).toBe("running");
  });

  it("joins Cloudflare error messages into the ApiError", async () => {
    const { c } = client([json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 403)]);
    await expect(c.listBuildTokens("acc")).rejects.toThrow("Authentication error (10000)");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/clients/cloudflare.test.ts`
Expected: FAIL, because the module can't be resolved.

- [ ] **Step 3: Implement the client**

`src/clients/cloudflare.ts`:

```ts
import { createJsonClient, type FetchFn } from "../http.ts";

export interface CloudflareAccount {
  id: string;
  name: string;
}

export interface CloudflareZone {
  id: string;
  name: string;
}

export interface BuildToken {
  build_token_uuid: string;
  build_token_name: string;
}

export interface RepoConnectionInput {
  provider_type: "github";
  provider_account_id: string;
  provider_account_name: string;
  repo_id: string;
  repo_name: string;
}

export interface TriggerInput {
  external_script_id: string;
  repo_connection_uuid: string;
  build_token_uuid: string;
  trigger_name: string;
  build_command: string;
  deploy_command: string;
  root_directory: string;
  branch_includes: string[];
  branch_excludes: string[];
  path_includes: string[];
  path_excludes: string[];
  build_caching_enabled: boolean;
}

export interface BuildTrigger {
  trigger_uuid: string;
  trigger_name: string;
}

export interface BuildInfo {
  build_uuid: string;
  status: string;
  build_outcome?: string | null;
}

export type TriggerVariables = Record<string, { value: string; is_secret: boolean }>;

export interface CloudflareClient {
  getUser(): Promise<{ id: string; email: string }>;
  listAccounts(): Promise<CloudflareAccount[]>;
  listZones(accountId: string): Promise<CloudflareZone[]>;
  getWorkerTag(accountId: string, scriptName: string): Promise<string | null>;
  listBuildTokens(accountId: string): Promise<BuildToken[]>;
  putRepoConnection(accountId: string, input: RepoConnectionInput): Promise<string>;
  listTriggers(accountId: string, workerTag: string): Promise<BuildTrigger[]>;
  createTrigger(accountId: string, input: TriggerInput): Promise<BuildTrigger>;
  setTriggerEnv(accountId: string, triggerUuid: string, vars: TriggerVariables): Promise<void>;
  startBuild(accountId: string, triggerUuid: string, branch: string): Promise<string>;
  getBuild(accountId: string, buildUuid: string): Promise<BuildInfo>;
}

interface Envelope<T> {
  success: boolean;
  result: T;
  errors?: { code: number; message: string }[];
  result_info?: { page: number; total_pages: number };
}

export function createCloudflareClient(o: { fetch: FetchFn; token: () => Promise<string> }): CloudflareClient {
  const http = createJsonClient({
    service: "cloudflare",
    baseUrl: "https://api.cloudflare.com/client/v4",
    fetch: o.fetch,
    token: o.token,
    errorMessage: (b) => {
      const errors = (b as Envelope<unknown> | null)?.errors;
      return errors?.length ? errors.map((e) => `${e.message} (${e.code})`).join("; ") : undefined;
    },
  });

  const call = async <T>(
    path: string,
    req: Parameters<typeof http.request>[1] = {},
  ): Promise<T> => (await http.request<Envelope<T>>(path, req)).result;

  async function paged<T>(path: string, query: Record<string, string> = {}): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const env = await http.request<Envelope<T[]>>(path, { query: { ...query, page, per_page: 50 } });
      out.push(...env.result);
      if (page >= (env.result_info?.total_pages ?? 1)) return out;
    }
  }

  const acct = (id: string) => `/accounts/${encodeURIComponent(id)}`;

  return {
    getUser: () => call<{ id: string; email: string }>("/user"),
    listAccounts: () => paged<CloudflareAccount>("/accounts"),
    listZones: (accountId) => paged<CloudflareZone>("/zones", { "account.id": accountId }),
    async getWorkerTag(accountId, scriptName) {
      const scripts = await call<{ id: string; tag?: string }[]>(`${acct(accountId)}/workers/scripts`);
      return scripts.find((s) => s.id === scriptName)?.tag ?? null;
    },
    listBuildTokens: (accountId) => call<BuildToken[]>(`${acct(accountId)}/builds/tokens`),
    async putRepoConnection(accountId, input) {
      const r = await call<{ repo_connection_uuid: string }>(`${acct(accountId)}/builds/repos/connections`, {
        method: "PUT",
        body: input,
      });
      return r.repo_connection_uuid;
    },
    listTriggers: (accountId, tag) =>
      call<BuildTrigger[]>(`${acct(accountId)}/builds/workers/${encodeURIComponent(tag)}/triggers`),
    createTrigger: (accountId, input) =>
      call<BuildTrigger>(`${acct(accountId)}/builds/triggers`, { method: "POST", body: input }),
    async setTriggerEnv(accountId, triggerUuid, vars) {
      await call(`${acct(accountId)}/builds/triggers/${triggerUuid}/environment_variables`, {
        method: "PATCH",
        body: vars,
      });
    },
    async startBuild(accountId, triggerUuid, branch) {
      const r = await call<{ build_uuid: string }>(`${acct(accountId)}/builds/triggers/${triggerUuid}/builds`, {
        method: "POST",
        body: { branch },
      });
      return r.build_uuid;
    },
    getBuild: (accountId, buildUuid) => call<BuildInfo>(`${acct(accountId)}/builds/builds/${buildUuid}`),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/clients/cloudflare.test.ts && pnpm typecheck`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/clients/cloudflare.ts tests/clients/cloudflare.test.ts
git commit -m "feat: add Cloudflare API client for accounts, zones and Workers Builds"
```

---

### Task 10: GitHub client

**Files:**
- Create: `src/clients/github.ts`
- Test: `tests/clients/github.test.ts`

**Interfaces:**
- Consumes: `createJsonClient`, `FetchFn` and `ApiError` (Task 2).
- Produces:
  - `interface GitHubRepo { id: number; name: string; ownerId: number; ownerLogin: string; defaultBranch: string; private: boolean }`
  - `interface PullRequest { url: string; number: number }`
  - `interface GitHubClient { getViewer(): Promise<{ login: string }>; getRepo(owner, repo): Promise<GitHubRepo>; getFile(owner, repo, path, ref): Promise<string | null>; listDir(owner, repo, path, ref): Promise<string[] | null>; findOpenPr(owner, repo, branch): Promise<PullRequest | null>; createPr(owner, repo, p: { title; head; base; body }): Promise<PullRequest> }`
  - `createGitHubClient(o: { fetch: FetchFn; token: () => Promise<string> }): GitHubClient`

- [ ] **Step 1: Write the failing tests**

`tests/clients/github.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createGitHubClient } from "../../src/clients/github.ts";
import { ApiError } from "../../src/http.ts";
import { fakeFetch, json } from "../helpers/fake-fetch.ts";

function client(responses: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(responses);
  return { c: createGitHubClient({ fetch: f.fetch, token: async () => "gho_x" }), calls: f.calls };
}

describe("createGitHubClient", () => {
  it("maps repo fields", async () => {
    const { c } = client([
      json({ id: 2, name: "app", owner: { id: 1, login: "acme" }, default_branch: "main", private: true }),
    ]);
    expect(await c.getRepo("acme", "app")).toEqual({
      id: 2,
      name: "app",
      ownerId: 1,
      ownerLogin: "acme",
      defaultBranch: "main",
      private: true,
    });
  });

  it("explains a 404 repo as a possible access or SSO problem", async () => {
    const { c } = client([json({ message: "Not Found" }, 404)]);
    const err = await c.getRepo("acme", "secret").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as Error).message).toContain("acme/secret");
    expect((err as Error).message).toContain("SSO");
  });

  it("decodes file contents and returns null for missing files and directories", async () => {
    const { c, calls } = client([
      json({ type: "file", encoding: "base64", content: Buffer.from('{"crons":[]}').toString("base64") }),
      json({ message: "Not Found" }, 404),
      json([{ name: "a" }]),
    ]);
    expect(await c.getFile("o", "r", "apps/web/vercel.json", "main")).toBe('{"crons":[]}');
    expect(calls[0]?.url).toBe("https://api.github.com/repos/o/r/contents/apps/web/vercel.json?ref=main");
    expect(await c.getFile("o", "r", "vercel.json", "main")).toBeNull();
    expect(await c.getFile("o", "r", "dir", "main")).toBeNull();
  });

  it("lists directory entries", async () => {
    const { c, calls } = client([json([{ name: "package.json" }, { name: "pnpm-lock.yaml" }])]);
    expect(await c.listDir("o", "r", "", "main")).toEqual(["package.json", "pnpm-lock.yaml"]);
    expect(calls[0]?.url).toBe("https://api.github.com/repos/o/r/contents/?ref=main");
  });

  it("finds an open PR from the migration branch, or creates one", async () => {
    const { c, calls } = client([
      json([]),
      json({ html_url: "https://github.com/o/r/pull/7", number: 7 }),
    ]);
    expect(await c.findOpenPr("o", "r", "cloudflare-migration")).toBeNull();
    expect(calls[0]?.url).toBe("https://api.github.com/repos/o/r/pulls?state=open&head=o%3Acloudflare-migration");
    const pr = await c.createPr("o", "r", { title: "t", head: "cloudflare-migration", base: "main", body: "b" });
    expect(pr).toEqual({ url: "https://github.com/o/r/pull/7", number: 7 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/clients/github.test.ts`
Expected: FAIL, because the module can't be resolved.

- [ ] **Step 3: Implement the client**

`src/clients/github.ts`:

```ts
import { ApiError, createJsonClient, type FetchFn } from "../http.ts";

export interface GitHubRepo {
  id: number;
  name: string;
  ownerId: number;
  ownerLogin: string;
  defaultBranch: string;
  private: boolean;
}

export interface PullRequest {
  url: string;
  number: number;
}

export interface GitHubClient {
  getViewer(): Promise<{ login: string }>;
  getRepo(owner: string, repo: string): Promise<GitHubRepo>;
  getFile(owner: string, repo: string, path: string, ref: string): Promise<string | null>;
  listDir(owner: string, repo: string, path: string, ref: string): Promise<string[] | null>;
  findOpenPr(owner: string, repo: string, branch: string): Promise<PullRequest | null>;
  createPr(owner: string, repo: string, p: { title: string; head: string; base: string; body: string }): Promise<PullRequest>;
}

const encodePath = (path: string) => path.split("/").filter(Boolean).map(encodeURIComponent).join("/");

export function createGitHubClient(o: { fetch: FetchFn; token: () => Promise<string> }): GitHubClient {
  const http = createJsonClient({
    service: "github",
    baseUrl: "https://api.github.com",
    fetch: o.fetch,
    token: o.token,
    headers: { "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "switchyard" },
    errorMessage: (b) => (b as { message?: string } | null)?.message,
  });
  const repoPath = (owner: string, repo: string) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  return {
    getViewer: () => http.request<{ login: string }>("/user"),
    async getRepo(owner, repo) {
      const r = await http.request<{
        id: number;
        name: string;
        owner: { id: number; login: string };
        default_branch: string;
        private: boolean;
      } | null>(repoPath(owner, repo), { allow404: true });
      if (!r) {
        throw new ApiError(
          "github",
          404,
          `Repository ${owner}/${repo} was not found, or the GitHub token can't access it. If it belongs to an organisation that uses SSO, authorise the token for that organisation (for gh: gh auth refresh).`,
        );
      }
      return {
        id: r.id,
        name: r.name,
        ownerId: r.owner.id,
        ownerLogin: r.owner.login,
        defaultBranch: r.default_branch,
        private: r.private,
      };
    },
    async getFile(owner, repo, path, ref) {
      const r = await http.request<{ type?: string; content?: string } | unknown[] | null>(
        `${repoPath(owner, repo)}/contents/${encodePath(path)}`,
        { query: { ref }, allow404: true },
      );
      if (!r || Array.isArray(r) || r.type !== "file" || typeof r.content !== "string") return null;
      return Buffer.from(r.content, "base64").toString("utf8");
    },
    async listDir(owner, repo, path, ref) {
      const r = await http.request<{ name: string }[] | null>(
        `${repoPath(owner, repo)}/contents/${encodePath(path)}`,
        { query: { ref }, allow404: true },
      );
      return Array.isArray(r) ? r.map((e) => e.name) : null;
    },
    async findOpenPr(owner, repo, branch) {
      const prs = await http.request<{ html_url: string; number: number }[]>(`${repoPath(owner, repo)}/pulls`, {
        query: { state: "open", head: `${owner}:${branch}` },
      });
      const pr = prs[0];
      return pr ? { url: pr.html_url, number: pr.number } : null;
    },
    async createPr(owner, repo, p) {
      const pr = await http.request<{ html_url: string; number: number }>(`${repoPath(owner, repo)}/pulls`, {
        method: "POST",
        body: p,
      });
      return { url: pr.html_url, number: pr.number };
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/clients/github.test.ts && pnpm typecheck`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/clients/github.ts tests/clients/github.test.ts
git commit -m "feat: add GitHub client for repo metadata, files and PRs"
```

---

### Task 11: Env plan

**Files:**
- Create: `src/translate/env-plan.ts`
- Test: `tests/translate/env-plan.test.ts`

**Interfaces:**
- Consumes: `VercelEnvVar` and `VercelTarget` (Task 8), and `TriggerVariables` (Task 9).
- Produces:
  - `type EnvDestination = "production-build" | "preview-build" | "runtime-secret" | "dev-vars"`
  - `interface EnvPlanEntry { id: string; key: string; targets: VercelTarget[]; vercelType: VercelEnvVar["type"]; hasValue: boolean; needsInput: boolean; isSecret: boolean; destinations: EnvDestination[]; skipReason?: string }`
  - `interface EnvPlan { entries: EnvPlanEntry[]; warnings: string[] }`
  - `type EnvValues = Record<string, string>` (keyed by entry `id`, kept apart from the plan)
  - `buildEnvPlan(vars: VercelEnvVar[], reserved: readonly string[]): { plan: EnvPlan; values: EnvValues }`
  - `skipEntries(plan: EnvPlan, ids: readonly string[]): EnvPlan`
  - `missingInputs(plan: EnvPlan, values: EnvValues): EnvPlanEntry[]`
  - `triggerVariables(plan, values, which: "production" | "preview"): TriggerVariables`
  - `runtimeSecrets(plan, values): Record<string, string>`
  - `devVarsFile(plan, values): string`
  - `secretKeys(plan): string[]`

- [ ] **Step 1: Write the failing tests**

`tests/translate/env-plan.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { VercelEnvVar } from "../../src/clients/vercel.ts";
import {
  buildEnvPlan,
  devVarsFile,
  missingInputs,
  runtimeSecrets,
  secretKeys,
  skipEntries,
  triggerVariables,
} from "../../src/translate/env-plan.ts";

const v = (over: Partial<VercelEnvVar>): VercelEnvVar => ({
  id: over.key ?? "id",
  key: "KEY",
  type: "encrypted",
  target: ["production"],
  value: "value",
  ...over,
});

const RESERVED = ["ASSETS", "IMAGES", "VINEXT_KV_CACHE"];

describe("buildEnvPlan", () => {
  it("sends production values to the production trigger and runtime secrets", () => {
    const { plan } = buildEnvPlan([v({ id: "1", key: "API_KEY" })], RESERVED);
    expect(plan.entries[0]).toMatchObject({
      key: "API_KEY",
      destinations: ["production-build", "runtime-secret"],
      isSecret: true,
      needsInput: false,
    });
  });

  it("sends preview values to the preview trigger and development values to .dev.vars", () => {
    const { plan } = buildEnvPlan(
      [v({ id: "1", key: "A", target: ["preview", "development"], type: "plain" })],
      RESERVED,
    );
    expect(plan.entries[0]?.destinations).toEqual(["preview-build", "dev-vars"]);
    expect(plan.entries[0]?.isSecret).toBe(false);
  });

  it("keeps values out of the plan", () => {
    const { plan, values } = buildEnvPlan([v({ id: "1", key: "A", value: "hunter22" })], RESERVED);
    expect(JSON.stringify(plan)).not.toContain("hunter22");
    expect(values).toEqual({ "1": "hunter22" });
  });

  it("asks for Sensitive values without a warning", () => {
    const { plan } = buildEnvPlan([v({ id: "1", key: "S", type: "sensitive", value: undefined })], RESERVED);
    expect(plan.entries[0]).toMatchObject({ needsInput: true, hasValue: false });
    expect(plan.warnings).toEqual([]);
  });

  it("asks for, and warns about, non-Sensitive values Vercel didn't return", () => {
    const { plan } = buildEnvPlan([v({ id: "1", key: "E", type: "encrypted", value: undefined })], RESERVED);
    expect(plan.entries[0]?.needsInput).toBe(true);
    expect(plan.warnings[0]).toContain("E");
  });

  it("skips system variables, branch-specific previews, reserved names and invalid names", () => {
    const { plan } = buildEnvPlan(
      [
        v({ id: "1", key: "VERCEL_URL", type: "system" }),
        v({ id: "2", key: "B", target: ["preview"], gitBranch: "feature-x" }),
        v({ id: "3", key: "ASSETS" }),
        v({ id: "4", key: "my-key" }),
      ],
      RESERVED,
    );
    expect(plan.entries.map((e) => [e.key, Boolean(e.skipReason), e.destinations])).toEqual([
      ["VERCEL_URL", true, []],
      ["B", true, []],
      ["ASSETS", true, []],
      ["my-key", true, []],
    ]);
    expect(plan.entries.every((e) => !e.needsInput)).toBe(true);
  });
});

describe("plan helpers", () => {
  const vars = [
    v({ id: "p", key: "API_KEY", value: "prod-secret" }),
    v({ id: "pv", key: "API_KEY", target: ["preview"], value: "preview-secret" }),
    v({ id: "pub", key: "NEXT_PUBLIC_URL", type: "plain", target: ["production", "preview"], value: "https://x" }),
    v({ id: "d", key: "LOCAL", type: "plain", target: ["development"], value: 'a "quoted"\nvalue' }),
    v({ id: "s", key: "SENSITIVE", type: "sensitive", value: undefined }),
  ];

  it("lists entries still missing a value", () => {
    const { plan, values } = buildEnvPlan(vars, RESERVED);
    expect(missingInputs(plan, values).map((e) => e.key)).toEqual(["SENSITIVE"]);
    expect(missingInputs(plan, { ...values, s: "typed" })).toEqual([]);
  });

  it("removes skipped entries from every destination", () => {
    const { plan, values } = buildEnvPlan(vars, RESERVED);
    const skipped = skipEntries(plan, ["s"]);
    expect(missingInputs(skipped, values)).toEqual([]);
    expect(Object.keys(runtimeSecrets(skipped, values))).not.toContain("SENSITIVE");
  });

  it("builds trigger variables per environment, marking secrets", () => {
    const { plan, values } = buildEnvPlan(vars, RESERVED);
    expect(triggerVariables(plan, { ...values, s: "typed" }, "production")).toEqual({
      API_KEY: { value: "prod-secret", is_secret: true },
      NEXT_PUBLIC_URL: { value: "https://x", is_secret: false },
      SENSITIVE: { value: "typed", is_secret: true },
    });
    expect(triggerVariables(plan, values, "preview")).toEqual({
      API_KEY: { value: "preview-secret", is_secret: true },
      NEXT_PUBLIC_URL: { value: "https://x", is_secret: false },
    });
  });

  it("builds runtime secrets from production values only", () => {
    const { plan, values } = buildEnvPlan(vars, RESERVED);
    expect(runtimeSecrets(plan, values)).toEqual({ API_KEY: "prod-secret", NEXT_PUBLIC_URL: "https://x" });
    expect(secretKeys(plan)).toEqual(["API_KEY", "NEXT_PUBLIC_URL", "SENSITIVE"]);
  });

  it("writes development values as an escaped .dev.vars file", () => {
    const { plan, values } = buildEnvPlan(vars, RESERVED);
    expect(devVarsFile(plan, values)).toBe('LOCAL="a \\"quoted\\"\\nvalue"\n');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/translate/env-plan.test.ts`
Expected: FAIL, because the module can't be resolved.

- [ ] **Step 3: Implement the env plan**

`src/translate/env-plan.ts`:

```ts
import type { TriggerVariables } from "../clients/cloudflare.ts";
import type { VercelEnvVar, VercelTarget } from "../clients/vercel.ts";

export type EnvDestination = "production-build" | "preview-build" | "runtime-secret" | "dev-vars";

export interface EnvPlanEntry {
  id: string;
  key: string;
  targets: VercelTarget[];
  vercelType: VercelEnvVar["type"];
  hasValue: boolean;
  needsInput: boolean;
  isSecret: boolean;
  destinations: EnvDestination[];
  skipReason?: string;
}

export interface EnvPlan {
  entries: EnvPlanEntry[];
  warnings: string[];
}

// Values are kept apart from the plan so the plan can be persisted and sent
// to the browser without ever containing a secret.
export type EnvValues = Record<string, string>;

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function destinationsFor(targets: readonly VercelTarget[]): EnvDestination[] {
  const out: EnvDestination[] = [];
  if (targets.includes("production")) out.push("production-build", "runtime-secret");
  if (targets.includes("preview")) out.push("preview-build");
  if (targets.includes("development")) out.push("dev-vars");
  return out;
}

function skipReasonFor(v: VercelEnvVar, reserved: readonly string[]): string | undefined {
  if (v.type === "system") return "Vercel system variable – Cloudflare doesn't provide an equivalent";
  if (v.gitBranch) {
    return `Preview value for the ${v.gitBranch} branch only – Workers Builds can't scope variables to one branch`;
  }
  if (!KEY_PATTERN.test(v.key)) return "Not a valid binding name on Cloudflare (letters, digits and _ only)";
  if (reserved.includes(v.key)) return "Name is already used by a binding the converter creates";
  return undefined;
}

export function buildEnvPlan(vars: VercelEnvVar[], reserved: readonly string[]): { plan: EnvPlan; values: EnvValues } {
  const values: EnvValues = {};
  const warnings: string[] = [];
  const entries = vars.map((v): EnvPlanEntry => {
    const skipReason = skipReasonFor(v, reserved);
    const hasValue = typeof v.value === "string";
    if (hasValue && !skipReason) values[v.id] = v.value as string;
    const needsInput = !skipReason && !hasValue;
    if (needsInput && v.type !== "sensitive") {
      warnings.push(
        `Vercel returned no value for ${v.key} (${v.type}). Enter it below, or check that the Vercel token can read this project's variables.`,
      );
    }
    return {
      id: v.id,
      key: v.key,
      targets: v.target,
      vercelType: v.type,
      hasValue,
      needsInput,
      isSecret: v.type !== "plain",
      destinations: skipReason ? [] : destinationsFor(v.target),
      ...(skipReason ? { skipReason } : {}),
    };
  });
  return { plan: { entries, warnings }, values };
}

export function skipEntries(plan: EnvPlan, ids: readonly string[]): EnvPlan {
  return {
    ...plan,
    entries: plan.entries.map((e) =>
      ids.includes(e.id) ? { ...e, destinations: [], needsInput: false, skipReason: "Skipped by you" } : e,
    ),
  };
}

export function missingInputs(plan: EnvPlan, values: EnvValues): EnvPlanEntry[] {
  return plan.entries.filter((e) => e.needsInput && !values[e.id]);
}

function withValues(plan: EnvPlan, values: EnvValues, destination: EnvDestination) {
  return plan.entries.flatMap((e) => {
    const value = values[e.id];
    return e.destinations.includes(destination) && value !== undefined ? [{ entry: e, value }] : [];
  });
}

export function triggerVariables(plan: EnvPlan, values: EnvValues, which: "production" | "preview"): TriggerVariables {
  const out: TriggerVariables = {};
  for (const { entry, value } of withValues(plan, values, `${which}-build`)) {
    out[entry.key] = { value, is_secret: entry.isSecret };
  }
  return out;
}

export function runtimeSecrets(plan: EnvPlan, values: EnvValues): Record<string, string> {
  return Object.fromEntries(withValues(plan, values, "runtime-secret").map(({ entry, value }) => [entry.key, value]));
}

export function devVarsFile(plan: EnvPlan, values: EnvValues): string {
  return withValues(plan, values, "dev-vars")
    .map(({ entry, value }) => `${entry.key}=${JSON.stringify(value)}\n`)
    .join("");
}

export function secretKeys(plan: EnvPlan): string[] {
  return [...new Set(plan.entries.filter((e) => e.destinations.includes("runtime-secret")).map((e) => e.key))];
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/translate/env-plan.test.ts && pnpm typecheck`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/translate/env-plan.ts tests/translate/env-plan.test.ts
git commit -m "feat: map Vercel env vars to Builds variables, Worker secrets and .dev.vars"
```

---

### Task 12: `vercel.json` translation

**Files:**
- Create: `src/translate/vercel-json.ts`
- Test: `tests/translate/vercel-json.test.ts`

**Interfaces:**
- Produces:
  - `interface CronJob { path: string; schedule: string }`
  - `interface VercelJsonTranslation { crons: CronJob[]; manual: string[] }`
  - `translateVercelJson(raw: string | null): VercelJsonTranslation`

- [ ] **Step 1: Write the failing tests**

`tests/translate/vercel-json.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { translateVercelJson } from "../../src/translate/vercel-json.ts";

describe("translateVercelJson", () => {
  it("returns nothing for a missing file", () => {
    expect(translateVercelJson(null)).toEqual({ crons: [], manual: [] });
  });

  it("reports a file it can't parse", () => {
    const t = translateVercelJson("{ nope");
    expect(t.crons).toEqual([]);
    expect(t.manual[0]).toContain("couldn't be parsed");
  });

  it("keeps valid crons and reports invalid ones", () => {
    const t = translateVercelJson(
      JSON.stringify({
        crons: [
          { path: "/api/cron", schedule: "0 5 * * *" },
          { path: "api/no-slash", schedule: "0 5 * * *" },
          { path: "/api/x", schedule: "every day" },
        ],
      }),
    );
    expect(t.crons).toEqual([{ path: "/api/cron", schedule: "0 5 * * *" }]);
    expect(t.manual).toHaveLength(2);
  });

  it("points redirects, rewrites and headers at next.config.js", () => {
    const t = translateVercelJson(
      JSON.stringify({
        redirects: [{ source: "/a", destination: "/b" }],
        rewrites: [{ source: "/c", destination: "/d" }, { source: "/e", destination: "/f" }],
        headers: [{ source: "/(.*)", headers: [{ key: "X", value: "1" }] }],
      }),
    );
    expect(t.manual).toEqual([
      "1 redirect in vercel.json – add it to `redirects()` in next.config.js.",
      "2 rewrites in vercel.json – add them to `rewrites()` in next.config.js.",
      "1 header rule in vercel.json – add it to `headers()` in next.config.js.",
    ]);
  });

  it("explains settings that have no Workers equivalent and ignores $schema", () => {
    const t = translateVercelJson(JSON.stringify({ $schema: "x", functions: {}, regions: ["iad1"], somethingNew: 1 }));
    expect(t.manual).toEqual([
      "`functions` (memory and duration limits) has no direct equivalent – Workers limits are set per plan and in `limits` in cloudflare.config.ts.",
      "`regions` has no direct equivalent – Workers run in every Cloudflare location. Smart Placement is the closest option.",
      "`somethingNew` in vercel.json isn't translated.",
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/translate/vercel-json.test.ts`
Expected: FAIL, because the module can't be resolved.

- [ ] **Step 3: Implement the translation**

`src/translate/vercel-json.ts`:

```ts
export interface CronJob {
  path: string;
  schedule: string;
}

export interface VercelJsonTranslation {
  crons: CronJob[];
  manual: string[];
}

const CRON_FIELDS = /^\S+(\s+\S+){4}$/;

const NOTES: Record<string, string> = {
  functions:
    "`functions` (memory and duration limits) has no direct equivalent – Workers limits are set per plan and in `limits` in cloudflare.config.ts.",
  regions:
    "`regions` has no direct equivalent – Workers run in every Cloudflare location. Smart Placement is the closest option.",
  cleanUrls: "`cleanUrls` isn't translated – Next.js handles routes itself.",
  trailingSlash: "`trailingSlash` isn't translated – set `trailingSlash` in next.config.js instead.",
  images: "`images` settings aren't translated – image optimisation now uses Cloudflare Images.",
  buildCommand: "`buildCommand` isn't used – Switchyard sets the Cloudflare build commands.",
  installCommand: "`installCommand` isn't used – Workers Builds installs dependencies from the lockfile.",
  outputDirectory: "`outputDirectory` isn't used – the Cloudflare build output goes to .cloudflare/output.",
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function translateVercelJson(raw: string | null): VercelJsonTranslation {
  if (raw === null) return { crons: [], manual: [] };
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    return { crons: [], manual: [`vercel.json couldn't be parsed (${(e as Error).message}), so nothing in it was translated.`] };
  }

  const crons: CronJob[] = [];
  const manual: string[] = [];

  for (const [key, value] of Object.entries(config)) {
    if (key === "$schema") continue;
    if (key === "crons" && Array.isArray(value)) {
      for (const c of value as Partial<CronJob>[]) {
        if (typeof c.path === "string" && c.path.startsWith("/") && typeof c.schedule === "string" && CRON_FIELDS.test(c.schedule.trim())) {
          crons.push({ path: c.path, schedule: c.schedule.trim() });
        } else {
          manual.push(`Cron job ${JSON.stringify(c)} in vercel.json isn't valid, so it wasn't translated.`);
        }
      }
      continue;
    }
    if ((key === "redirects" || key === "rewrites" || key === "headers") && Array.isArray(value)) {
      const n = value.length;
      const [one, many, fn] =
        key === "redirects"
          ? ["redirect", "redirects", "redirects()"]
          : key === "rewrites"
            ? ["rewrite", "rewrites", "rewrites()"]
            : ["header rule", "header rules", "headers()"];
      manual.push(`${plural(n, one, many)} in vercel.json – add ${n === 1 ? "it" : "them"} to \`${fn}\` in next.config.js.`);
      continue;
    }
    manual.push(NOTES[key] ?? `\`${key}\` in vercel.json isn't translated.`);
  }
  return { crons, manual };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/translate/vercel-json.test.ts && pnpm typecheck`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/translate/vercel-json.ts tests/translate/vercel-json.test.ts
git commit -m "feat: translate vercel.json crons and report settings needing manual moves"
```

---

### Task 13: Detection helpers (package.json, package manager, storage, Vercel features, token scope)

**Files:**
- Create: `src/translate/package-json.ts`, `src/translate/package-manager.ts`, `src/translate/storage.ts`, `src/translate/features.ts`, `src/translate/token-scope.ts`
- Test: `tests/translate/detect.test.ts`

**Interfaces:**
- Consumes: `ScopeProbe` and `VercelTeam` (Task 8).
- Produces:
  - `interface PackageJson { name?: string; packageManager?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }`, `parsePackageJson(text: string | null): PackageJson | null` and `allDependencies(pkg: PackageJson | null): Record<string, string>`
  - `type PackageManager = "pnpm" | "npm" | "yarn" | "bun"`, `detectPackageManager(files: readonly string[], pkg: PackageJson | null): PackageManager`, `execCommand(pm, bin, args): { cmd: string; args: string[] }`, `execString(pm, line): string` and `dlxCommand(pm, pkg, args): { cmd: string; args: string[] }`
  - `interface StorageFinding { kind: string; label: string; evidence: string[]; suggestion: string }` and `detectStorage(input: { envKeys: readonly string[]; dependencies: Record<string, string> }): StorageFinding[]`
  - `interface FeatureFinding { package: string; note: string }` and `detectVercelFeatures(dependencies: Record<string, string>): FeatureFinding[]`
  - `type TokenScope = { kind: "account"; teams: VercelTeam[] } | { kind: "team" } | { kind: "limited" }` and `inferTokenScope(p: ScopeProbe): TokenScope`

- [ ] **Step 1: Write the failing tests**

`tests/translate/detect.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { detectVercelFeatures } from "../../src/translate/features.ts";
import { allDependencies, parsePackageJson } from "../../src/translate/package-json.ts";
import { detectPackageManager, dlxCommand, execCommand, execString } from "../../src/translate/package-manager.ts";
import { detectStorage } from "../../src/translate/storage.ts";
import { inferTokenScope } from "../../src/translate/token-scope.ts";

describe("package.json", () => {
  it("parses, and returns null for missing or invalid files", () => {
    expect(parsePackageJson('{"name":"a"}')).toEqual({ name: "a" });
    expect(parsePackageJson(null)).toBeNull();
    expect(parsePackageJson("{x")).toBeNull();
    expect(parsePackageJson("[]")).toBeNull();
  });

  it("merges dependencies and devDependencies", () => {
    expect(allDependencies({ dependencies: { a: "1" }, devDependencies: { b: "2" } })).toEqual({ a: "1", b: "2" });
    expect(allDependencies(null)).toEqual({});
  });
});

describe("package manager", () => {
  it("prefers the packageManager field, then lockfiles, then npm", () => {
    expect(detectPackageManager(["yarn.lock"], { packageManager: "pnpm@10.33.0" })).toBe("pnpm");
    expect(detectPackageManager(["pnpm-lock.yaml"], {})).toBe("pnpm");
    expect(detectPackageManager(["yarn.lock"], {})).toBe("yarn");
    expect(detectPackageManager(["bun.lock"], {})).toBe("bun");
    expect(detectPackageManager([], null)).toBe("npm");
  });

  it("builds exec and dlx commands", () => {
    expect(execCommand("pnpm", "cf", ["build"])).toEqual({ cmd: "pnpm", args: ["exec", "cf", "build"] });
    expect(execCommand("npm", "cf", ["build"])).toEqual({ cmd: "npx", args: ["--no-install", "cf", "build"] });
    expect(execString("yarn", "cf deploy --prebuilt")).toBe("yarn cf deploy --prebuilt");
    expect(dlxCommand("pnpm", "vinext@1.1.0", ["init"])).toEqual({ cmd: "pnpm", args: ["dlx", "vinext@1.1.0", "init"] });
    expect(dlxCommand("npm", "vinext@1.1.0", ["init"])).toEqual({ cmd: "npx", args: ["--yes", "vinext@1.1.0", "init"] });
    expect(dlxCommand("bun", "vinext@1.1.0", ["init"])).toEqual({ cmd: "bunx", args: ["vinext@1.1.0", "init"] });
  });
});

describe("detectStorage", () => {
  it("finds Vercel Blob from env and dependency evidence", () => {
    const f = detectStorage({ envKeys: ["BLOB_READ_WRITE_TOKEN"], dependencies: { "@vercel/blob": "1" } });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "vercel-blob", evidence: ["BLOB_READ_WRITE_TOKEN", "@vercel/blob"] });
  });

  it("finds several stores and nothing when there is no evidence", () => {
    expect(
      detectStorage({ envKeys: ["KV_REST_API_URL", "POSTGRES_URL"], dependencies: { "@supabase/supabase-js": "2" } }).map(
        (f) => f.kind,
      ),
    ).toEqual(["vercel-kv", "vercel-postgres", "supabase"]);
    expect(detectStorage({ envKeys: ["API_KEY"], dependencies: { react: "19" } })).toEqual([]);
  });
});

describe("detectVercelFeatures", () => {
  it("lists Vercel-only packages", () => {
    expect(detectVercelFeatures({ "@vercel/analytics": "1", "@vercel/og": "1", next: "16" }).map((f) => f.package)).toEqual([
      "@vercel/analytics",
      "@vercel/og",
    ]);
  });
});

describe("inferTokenScope", () => {
  const team = { id: "t", slug: "acme", name: "Acme" };

  it("treats a token that can read the user as full-account", () => {
    expect(inferTokenScope({ userOk: true, user: null, teams: [team], projectsOk: true })).toEqual({
      kind: "account",
      teams: [team],
    });
  });

  it("treats a token that lists projects but not the user as team-scoped", () => {
    expect(inferTokenScope({ userOk: false, user: null, teams: null, projectsOk: true })).toEqual({ kind: "team" });
  });

  it("treats a token that can't list projects as too limited", () => {
    expect(inferTokenScope({ userOk: true, user: null, teams: [], projectsOk: false })).toEqual({ kind: "limited" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/translate/detect.test.ts`
Expected: FAIL, because the modules can't be resolved.

- [ ] **Step 3: Implement the five modules**

`src/translate/package-json.ts`:

```ts
export interface PackageJson {
  name?: string;
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export function parsePackageJson(text: string | null): PackageJson | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as PackageJson) : null;
  } catch {
    return null;
  }
}

export function allDependencies(pkg: PackageJson | null): Record<string, string> {
  return { ...pkg?.dependencies, ...pkg?.devDependencies };
}
```

`src/translate/package-manager.ts`:

```ts
import type { PackageJson } from "./package-json.ts";

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";
const MANAGERS: readonly PackageManager[] = ["pnpm", "npm", "yarn", "bun"];

export function detectPackageManager(files: readonly string[], pkg: PackageJson | null): PackageManager {
  const declared = pkg?.packageManager?.split("@")[0];
  if (declared && (MANAGERS as readonly string[]).includes(declared)) return declared as PackageManager;
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  if (files.includes("bun.lock") || files.includes("bun.lockb")) return "bun";
  return "npm";
}

// Runs a binary installed in the project's node_modules.
export function execCommand(pm: PackageManager, bin: string, args: readonly string[]): { cmd: string; args: string[] } {
  switch (pm) {
    case "pnpm":
      return { cmd: "pnpm", args: ["exec", bin, ...args] };
    case "yarn":
      return { cmd: "yarn", args: [bin, ...args] };
    case "bun":
      return { cmd: "bunx", args: [bin, ...args] };
    case "npm":
      return { cmd: "npx", args: ["--no-install", bin, ...args] };
  }
}

// The same command as a single string, for Workers Builds build and deploy commands.
export function execString(pm: PackageManager, line: string): string {
  const [bin = "", ...args] = line.split(" ");
  const c = execCommand(pm, bin, args);
  return [c.cmd, ...c.args].join(" ");
}

// Runs a package that isn't installed in the project.
export function dlxCommand(pm: PackageManager, pkg: string, args: readonly string[]): { cmd: string; args: string[] } {
  switch (pm) {
    case "pnpm":
      return { cmd: "pnpm", args: ["dlx", pkg, ...args] };
    case "yarn":
      return { cmd: "yarn", args: ["dlx", pkg, ...args] };
    case "bun":
      return { cmd: "bunx", args: [pkg, ...args] };
    case "npm":
      return { cmd: "npx", args: ["--yes", pkg, ...args] };
  }
}
```

`src/translate/storage.ts`:

```ts
export interface StorageFinding {
  kind: string;
  label: string;
  evidence: string[];
  suggestion: string;
}

interface Rule {
  kind: string;
  label: string;
  env: string[];
  deps: string[];
  suggestion: string;
}

const RULES: Rule[] = [
  {
    kind: "vercel-blob",
    label: "Vercel Blob",
    env: ["BLOB_READ_WRITE_TOKEN"],
    deps: ["@vercel/blob"],
    suggestion:
      "Blob files are reached with BLOB_READ_WRITE_TOKEN, which has been copied, so they stay reachable from Workers. R2 is the Cloudflare equivalent if you want to move them later.",
  },
  {
    kind: "vercel-kv",
    label: "Vercel KV (Upstash Redis)",
    env: ["KV_REST_API_URL", "KV_REST_API_TOKEN", "KV_URL"],
    deps: ["@vercel/kv"],
    suggestion: "Upstash Redis is reached over HTTPS with the copied credentials, so it keeps working from Workers.",
  },
  {
    kind: "vercel-postgres",
    label: "Vercel Postgres (Neon)",
    env: ["POSTGRES_URL", "POSTGRES_PRISMA_URL"],
    deps: ["@vercel/postgres"],
    suggestion:
      "Neon is reached with the copied connection string. Hyperdrive can pool connections if you use TCP drivers such as pg.",
  },
  {
    kind: "upstash",
    label: "Upstash",
    env: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
    deps: ["@upstash/redis"],
    suggestion: "Upstash is reached over HTTPS with the copied credentials, so it keeps working from Workers.",
  },
  {
    kind: "neon",
    label: "Neon",
    env: [],
    deps: ["@neondatabase/serverless"],
    suggestion: "The Neon serverless driver works on Workers with the copied DATABASE_URL.",
  },
  {
    kind: "supabase",
    label: "Supabase",
    env: ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"],
    deps: ["@supabase/supabase-js"],
    suggestion: "Supabase is reached over HTTPS with the copied keys, so it keeps working from Workers.",
  },
];

export function detectStorage(input: { envKeys: readonly string[]; dependencies: Record<string, string> }): StorageFinding[] {
  return RULES.flatMap((rule) => {
    const evidence = [
      ...rule.env.filter((k) => input.envKeys.includes(k)),
      ...rule.deps.filter((d) => d in input.dependencies),
    ];
    return evidence.length ? [{ kind: rule.kind, label: rule.label, evidence, suggestion: rule.suggestion }] : [];
  });
}
```

`src/translate/features.ts`:

```ts
export interface FeatureFinding {
  package: string;
  note: string;
}

const NOTES: Record<string, string> = {
  "@vercel/analytics": "Vercel Web Analytics won't record visits from Cloudflare. Cloudflare Web Analytics is the closest equivalent.",
  "@vercel/speed-insights": "Speed Insights won't report from Cloudflare. Cloudflare Web Analytics includes Core Web Vitals.",
  "@vercel/og": "Check that Open Graph images still render under vinext before merging.",
  "@vercel/edge-config": "Edge Config is a Vercel service. Reads keep working with the copied EDGE_CONFIG value; KV is the Cloudflare equivalent.",
  "@vercel/functions": "Helpers such as waitUntil and geolocation are Vercel-specific. On Workers, use ctx.waitUntil and request.cf.",
};

export function detectVercelFeatures(dependencies: Record<string, string>): FeatureFinding[] {
  return Object.entries(NOTES).flatMap(([pkg, note]) => (pkg in dependencies ? [{ package: pkg, note }] : []));
}
```

`src/translate/token-scope.ts`:

```ts
import type { ScopeProbe, VercelTeam } from "../clients/vercel.ts";

export type TokenScope = { kind: "account"; teams: VercelTeam[] } | { kind: "team" } | { kind: "limited" };

// Rule confirmed (or adjusted) by spike 4 in docs/spikes.md.
export function inferTokenScope(p: ScopeProbe): TokenScope {
  if (!p.projectsOk) return { kind: "limited" };
  if (p.userOk) return { kind: "account", teams: p.teams ?? [] };
  return { kind: "team" };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/translate/detect.test.ts && pnpm typecheck`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/translate tests/translate/detect.test.ts
git commit -m "feat: detect package manager, storage, Vercel-only features and token scope"
```

---

### Task 14: Code generation (config edits, cron entry, `.gitignore`, PR body)

**Files:**
- Create: `src/codegen/config-edit.ts`, `src/codegen/cron-entry.ts`, `src/codegen/gitignore.ts`, `src/codegen/pr-body.ts`
- Test: `tests/codegen/config-edit.test.ts`, `tests/codegen/codegen.test.ts`

**Interfaces:**
- Consumes: `CronJob` (Task 12), and `StorageFinding` and `FeatureFinding` (Task 13).
- Produces:
  - `interface ConfigEdits { workerName: string; secretKeys: readonly string[]; crons: readonly CronJob[]; entrypoint?: string }`, `class ConfigEditError extends Error` and `editCloudflareConfig(source: string, edits: ConfigEdits): string`
  - `CRON_ENTRY_FILE = "switchyard-entry.ts"` and `cronEntrySource(baseEntrypoint: string, crons: readonly CronJob[]): string`
  - `addGitignoreEntries(existing: string, entries: readonly string[]): string`
  - `interface PrBodyInput { projectName: string; productionBranch: string; workersDevUrl?: string; hasCrons: boolean; skippedEnv: { key: string; reason: string }[]; manual: string[]; features: FeatureFinding[]; storage: StorageFinding[]; warnings: string[] }` and `prBody(i: PrBodyInput): string`

- [ ] **Step 1: Write the failing config-edit tests**

`tests/codegen/config-edit.test.ts`:

```ts
import { parseModule } from "magicast";
import { describe, expect, it } from "vitest";
import { ConfigEditError, editCloudflareConfig } from "../../src/codegen/config-edit.ts";

// Verbatim output of `vinext init --platform=cloudflare --cdn-cache=data-cache --data-cache=kv
// --image-optimization=cloudflare-images` (vinext 1.1.0, probed 2026-10-14).
const VINEXT_CONFIG = `import { bindings, defineConfig, defineWorker } from "cf/config";

export default defineConfig({
  worker: defineWorker({
    name: "probe-next",
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-10-14",
    compatibilityFlags: ["nodejs_compat"],
    assets: { notFoundHandling: "none" },
    env: {
      ASSETS: bindings.assets(),
      IMAGES: bindings.images(),
      VINEXT_KV_CACHE: bindings.kv(),
    },
  }),
});
`;

describe("editCloudflareConfig", () => {
  it("sets the name, declares secrets, adds cron triggers and swaps the entrypoint", () => {
    const out = editCloudflareConfig(VINEXT_CONFIG, {
      workerName: "my-app",
      secretKeys: ["API_KEY", "DATABASE_URL"],
      crons: [
        { path: "/api/a", schedule: "0 * * * *" },
        { path: "/api/b", schedule: "0 * * * *" },
        { path: "/api/c", schedule: "30 2 * * *" },
      ],
      entrypoint: "./switchyard-entry.ts",
    });
    expect(out).toContain('name: "my-app"');
    expect(out).toContain('entrypoint: "./switchyard-entry.ts"');
    expect(out).toContain("API_KEY: bindings.secret()");
    expect(out).toContain("DATABASE_URL: bindings.secret()");
    expect(out).toContain("VINEXT_KV_CACHE: bindings.kv()");
    expect(out.match(/triggers\.scheduled/g)).toHaveLength(2);
    expect(out).toMatch(/import \{[^}]*\btriggers\b[^}]*\} from "cf\/config"/);
    expect(() => parseModule(out)).not.toThrow();
  });

  it("leaves the entrypoint and triggers alone when there are no crons", () => {
    const out = editCloudflareConfig(VINEXT_CONFIG, { workerName: "x", secretKeys: [], crons: [] });
    expect(out).toContain('entrypoint: "vinext/server/fetch-handler"');
    expect(out).not.toContain("triggers");
  });

  it("does not redeclare a key that already exists", () => {
    const out = editCloudflareConfig(VINEXT_CONFIG, { workerName: "x", secretKeys: ["ASSETS"], crons: [] });
    expect(out.match(/ASSETS:/g)).toHaveLength(1);
  });

  it("handles a plain-object worker without defineWorker and adds missing imports", () => {
    const src = `import { defineConfig } from "cf/config";\nexport default defineConfig({ worker: { name: "b" } });\n`;
    const out = editCloudflareConfig(src, { workerName: "c", secretKeys: ["K"], crons: [] });
    expect(out).toContain("K: bindings.secret()");
    expect(out).toMatch(/import \{[^}]*\bbindings\b[^}]*\} from "cf\/config"/);
  });

  it("explains configs it can't understand", () => {
    expect(() => editCloudflareConfig("export const x = 1;\n", { workerName: "x", secretKeys: [], crons: [] })).toThrow(
      ConfigEditError,
    );
  });
});
```

- [ ] **Step 2: Write the failing tests for the other generators**

`tests/codegen/codegen.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cronEntrySource } from "../../src/codegen/cron-entry.ts";
import { addGitignoreEntries } from "../../src/codegen/gitignore.ts";
import { prBody } from "../../src/codegen/pr-body.ts";

describe("cronEntrySource", () => {
  const src = cronEntrySource("vinext/server/fetch-handler", [
    { path: "/api/a", schedule: "0 * * * *" },
    { path: "/api/b", schedule: "0 * * * *" },
    { path: "/api/c", schedule: "30 2 * * *" },
  ]);

  it("wraps the base entry and keeps its named exports", () => {
    expect(src).toContain('import app from "vinext/server/fetch-handler";');
    expect(src).toContain('export * from "vinext/server/fetch-handler";');
    expect(src).toContain("app.fetch(request, env, ctx)");
  });

  it("groups paths by schedule", () => {
    expect(src).toContain('"0 * * * *": ["/api/a","/api/b"]');
    expect(src).toContain('"30 2 * * *": ["/api/c"]');
  });

  it("sends CRON_SECRET the way Vercel Cron does", () => {
    expect(src).toContain("Bearer ${env.CRON_SECRET}");
    expect(src).toContain('"user-agent": "vercel-cron/1.0"');
  });
});

describe("addGitignoreEntries", () => {
  it("appends only missing entries under a comment", () => {
    expect(addGitignoreEntries("node_modules\n.env\n", ["node_modules/", ".dev.vars"])).toBe(
      "node_modules\n.env\n\n# Added by Switchyard\n.dev.vars\n",
    );
  });

  it("returns the input unchanged when nothing is missing", () => {
    expect(addGitignoreEntries("/.dev.vars\n", [".dev.vars"])).toBe("/.dev.vars\n");
  });

  it("handles an empty file and a file without a trailing newline", () => {
    expect(addGitignoreEntries("", [".dev.vars"])).toBe("\n# Added by Switchyard\n.dev.vars\n");
    expect(addGitignoreEntries("dist", [".dev.vars"])).toBe("dist\n\n# Added by Switchyard\n.dev.vars\n");
  });
});

describe("prBody", () => {
  const body = prBody({
    projectName: "shop",
    productionBranch: "main",
    workersDevUrl: "https://shop.acme.workers.dev",
    hasCrons: true,
    skippedEnv: [{ key: "VERCEL_URL", reason: "Vercel system variable" }],
    manual: ["1 redirect in vercel.json – add it to `redirects()` in next.config.js."],
    features: [{ package: "@vercel/analytics", note: "Won't record visits." }],
    storage: [{ kind: "vercel-blob", label: "Vercel Blob", evidence: ["@vercel/blob"], suggestion: "Keeps working." }],
    warnings: ["pnpm blocked some build scripts."],
  });

  it("links the deploy and lists every manual item as a checkbox", () => {
    expect(body).toContain("**shop**");
    expect(body).toContain("https://shop.acme.workers.dev");
    expect(body).toContain("- [ ] 1 redirect in vercel.json");
    expect(body).toContain("- [ ] `VERCEL_URL` was not copied: Vercel system variable");
    expect(body).toContain("- [ ] `@vercel/analytics`: Won't record visits.");
    expect(body).toContain("- [ ] pnpm blocked some build scripts.");
    expect(body).toContain("Vercel Blob: Keeps working.");
    expect(body).toContain("Cron Triggers");
  });

  it("omits empty sections and never prints undefined", () => {
    const minimal = prBody({
      projectName: "x",
      productionBranch: "main",
      hasCrons: false,
      skippedEnv: [],
      manual: [],
      features: [],
      storage: [],
      warnings: [],
    });
    expect(minimal).not.toContain("undefined");
    expect(minimal).not.toContain("## Storage");
    expect(minimal).not.toContain("Cron Triggers");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test tests/codegen`
Expected: FAIL, because the modules can't be resolved.

- [ ] **Step 4: Implement the generators**

`src/codegen/config-edit.ts`:

```ts
import { builders, generateCode, parseModule, type ProxifiedModule } from "magicast";
import type { CronJob } from "../translate/vercel-json.ts";

export interface ConfigEdits {
  workerName: string;
  secretKeys: readonly string[];
  crons: readonly CronJob[];
  entrypoint?: string;
}

export class ConfigEditError extends Error {
  constructor(message: string) {
    super(`Couldn't update cloudflare.config.ts: ${message}`);
    this.name = "ConfigEditError";
  }
}

function ensureImport(mod: ProxifiedModule, name: string): void {
  if (!(name in mod.imports)) mod.imports.$prepend({ from: "cf/config", imported: name });
}

// Edits the config the converter generated, through the syntax tree rather
// than with string replacement, so formatting and unrelated settings survive.
export function editCloudflareConfig(source: string, edits: ConfigEdits): string {
  const mod = parseModule(source);
  const exported = mod.exports.default;
  if (!exported || exported.$type !== "function-call") {
    throw new ConfigEditError("expected `export default defineConfig({ ... })`");
  }
  const workerNode = exported.$args[0]?.worker;
  if (!workerNode) throw new ConfigEditError("no `worker` entry was found");
  const worker = workerNode.$type === "function-call" ? workerNode.$args[0] : workerNode;

  worker.name = edits.workerName;
  if (edits.entrypoint) worker.entrypoint = edits.entrypoint;

  if (edits.secretKeys.length) {
    if (!worker.env) worker.env = {};
    for (const key of edits.secretKeys) {
      if (!(key in worker.env)) worker.env[key] = builders.raw("bindings.secret()");
    }
    ensureImport(mod, "bindings");
  }

  const schedules = [...new Set(edits.crons.map((c) => c.schedule))];
  if (schedules.length) {
    const items = schedules.map((s) => builders.raw(`triggers.scheduled({ schedule: ${JSON.stringify(s)} })`));
    if (worker.triggers) for (const item of items) worker.triggers.push(item);
    else worker.triggers = items;
    ensureImport(mod, "triggers");
  }

  return generateCode(mod).code;
}
```

`src/codegen/cron-entry.ts`:

```ts
import type { CronJob } from "../translate/vercel-json.ts";

export const CRON_ENTRY_FILE = "switchyard-entry.ts";

// A Worker entry that keeps the framework's fetch handler and adds a scheduled
// handler calling the routes Vercel Cron Jobs used to call, with the same headers.
export function cronEntrySource(baseEntrypoint: string, crons: readonly CronJob[]): string {
  const bySchedule: Record<string, string[]> = {};
  for (const c of crons) (bySchedule[c.schedule] ??= []).push(c.path);
  const schedules = Object.entries(bySchedule)
    .map(([schedule, paths]) => `  ${JSON.stringify(schedule)}: ${JSON.stringify(paths)},`)
    .join("\n");
  const base = JSON.stringify(baseEntrypoint);

  return `// Generated by Switchyard. Runs the routes that Vercel Cron Jobs used to call.
import app from ${base};

export * from ${base};

const SCHEDULES: Record<string, string[]> = {
${schedules}
};

export default {
  fetch: (request: Request, env: Record<string, unknown>, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  async scheduled(controller: ScheduledController, env: Record<string, unknown>, ctx: ExecutionContext) {
    const headers = new Headers({ "user-agent": "vercel-cron/1.0" });
    if (typeof env.CRON_SECRET === "string") headers.set("authorization", \`Bearer \${env.CRON_SECRET}\`);
    for (const path of SCHEDULES[controller.cron] ?? []) {
      ctx.waitUntil(app.fetch(new Request(new URL(path, "https://localhost"), { headers }), env, ctx));
    }
  },
};
`;
}
```

`src/codegen/gitignore.ts`:

```ts
const normalise = (line: string) => line.trim().replace(/^\//, "").replace(/\/$/, "");

export function addGitignoreEntries(existing: string, entries: readonly string[]): string {
  const present = new Set(existing.split(/\r?\n/).map(normalise));
  const missing = entries.filter((e) => !present.has(normalise(e)));
  if (!missing.length) return existing;
  const base = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
  return `${base}\n# Added by Switchyard\n${missing.join("\n")}\n`;
}
```

`src/codegen/pr-body.ts`:

```ts
import type { FeatureFinding } from "../translate/features.ts";
import type { StorageFinding } from "../translate/storage.ts";

export interface PrBodyInput {
  projectName: string;
  productionBranch: string;
  workersDevUrl?: string;
  hasCrons: boolean;
  skippedEnv: { key: string; reason: string }[];
  manual: string[];
  features: FeatureFinding[];
  storage: StorageFinding[];
  warnings: string[];
}

const section = (title: string, lines: string[]) => (lines.length ? [`## ${title}`, "", ...lines, ""] : []);

export function prBody(i: PrBodyInput): string {
  const changed = [
    "- Converted the app to run on Cloudflare Workers with vinext (`vite.config.ts`, `cloudflare.config.ts` and new scripts in `package.json`).",
    "- Declared the production environment variables as Worker secrets in `cloudflare.config.ts`. Their values were uploaded to Cloudflare and are not in this PR.",
    ...(i.hasCrons ? ["- Moved Vercel Cron Jobs to Cron Triggers, run by `switchyard-entry.ts`."] : []),
  ];
  const checks = [
    i.workersDevUrl
      ? `- [ ] Check the Cloudflare deploy at ${i.workersDevUrl}`
      : "- [ ] Check the Cloudflare deploy (its workers.dev URL is in the Cloudflare dashboard)",
    ...i.manual.map((m) => `- [ ] ${m}`),
    ...i.skippedEnv.map((e) => `- [ ] \`${e.key}\` was not copied: ${e.reason}`),
    ...i.features.map((f) => `- [ ] \`${f.package}\`: ${f.note}`),
    ...i.warnings.map((w) => `- [ ] ${w}`),
  ];
  return [
    `This PR moves **${i.projectName}** from Vercel to Cloudflare Workers. It was prepared by Switchyard.`,
    "",
    ...section("What changed", changed),
    ...section("Before merging", checks),
    ...section(
      "Storage",
      i.storage.map((s) => `- ${s.label}: ${s.suggestion}`),
    ),
    ...section("After merging", [
      `Workers Builds deploys \`${i.productionBranch}\` to Cloudflare on every push. Vercel keeps serving your domains until you run the cut-over in Switchyard.`,
      "",
      "Other branches are built on Cloudflare to check they compile, but are not deployed at this point.",
    ]),
  ].join("\n");
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test tests/codegen && pnpm typecheck`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/codegen tests/codegen
git commit -m "feat: generate config edits, cron entry, gitignore entries and PR body"
```

---

### Task 15: Next.js adapter, adapter registry and the Next.js fixture

**Files:**
- Create: `src/adapters/types.ts`, `src/adapters/nextjs.ts`, `src/adapters/registry.ts`
- Create: `tests/fixtures/apps/nextjs-basic/package.json`, `tests/fixtures/apps/nextjs-basic/app/layout.tsx`, `tests/fixtures/apps/nextjs-basic/app/page.tsx` and `tests/fixtures/apps/nextjs-basic/app/api/cron/route.ts`
- Test: `tests/adapters/adapters.test.ts`, `tests/fixtures/nextjs.fixture.test.ts`

**Interfaces:**
- Consumes: `CommandRunner` and `runOrThrow` (Task 7), `PackageJson` and `allDependencies` (Task 13), `PackageManager` and `dlxCommand` (Task 13), and `VINEXT_VERSION` (Task 5).
- Produces:
  - `type SupportLevel = "supported" | "partial" | "unsupported"` and `interface Support { level: SupportLevel; reason?: string }`
  - `type NextCachePreset = "kv" | "none"` and `interface AdapterOptions { nextCache: NextCachePreset }`
  - `interface ConvertContext { dir: string; pm: PackageManager; run: CommandRunner; log: (line: string) => void; options: AdapterOptions }`
  - `interface ConvertResult { baseEntrypoint: string; warnings: string[] }`
  - `interface DetectInput { vercelFramework: string | null; packageJson: PackageJson | null }`
  - `interface Adapter { id: string; label: string; support: Support; reservedBindings: readonly string[]; matches(input: DetectInput): boolean; convert(ctx: ConvertContext): Promise<ConvertResult> }`
  - `nextjsAdapter: Adapter`, `NEXT_CACHE_FLAGS`
  - `ADAPTERS`, `adapterById(id: string | null): Adapter | null`, `pickAdapter(input): { adapter: Adapter | null; support: Support }` and `supportForFramework(framework: string | null): Support`

- [ ] **Step 1: Write the failing unit tests**

`tests/adapters/adapters.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { nextjsAdapter } from "../../src/adapters/nextjs.ts";
import { adapterById, pickAdapter, supportForFramework } from "../../src/adapters/registry.ts";
import { fakeRunner } from "../helpers/fake-runner.ts";

describe("nextjsAdapter", () => {
  it("matches Vercel's framework or a next dependency", () => {
    expect(nextjsAdapter.matches({ vercelFramework: "nextjs", packageJson: null })).toBe(true);
    expect(nextjsAdapter.matches({ vercelFramework: null, packageJson: { dependencies: { next: "16" } } })).toBe(true);
    expect(nextjsAdapter.matches({ vercelFramework: "vite", packageJson: { dependencies: {} } })).toBe(false);
  });

  it("runs a pinned vinext init with every choice passed as a flag", async () => {
    const { run, calls } = fakeRunner();
    const result = await nextjsAdapter.convert({ dir: "/w", pm: "pnpm", run, log: () => {}, options: { nextCache: "kv" } });
    expect(calls[0]).toMatchObject({
      cmd: "pnpm",
      args: [
        "dlx",
        "vinext@1.1.0",
        "init",
        "--platform=cloudflare",
        "--cdn-cache=data-cache",
        "--data-cache=kv",
        "--image-optimization=cloudflare-images",
      ],
      opts: { cwd: "/w" },
    });
    expect(result).toEqual({ baseEntrypoint: "vinext/server/fetch-handler", warnings: [] });
  });

  it("uses the no-cache preset when asked", async () => {
    const { run, calls } = fakeRunner();
    await nextjsAdapter.convert({ dir: "/w", pm: "npm", run, log: () => {}, options: { nextCache: "none" } });
    expect(calls[0]?.cmd).toBe("npx");
    expect(calls[0]?.args).toContain("--cdn-cache=none");
    expect(calls[0]?.args).toContain("--data-cache=none");
  });

  it("warns when pnpm blocked build scripts", async () => {
    const { run } = fakeRunner(() => ({ code: 0, output: "Run pnpm approve-builds to review" }));
    const r = await nextjsAdapter.convert({ dir: "/w", pm: "pnpm", run, log: () => {}, options: { nextCache: "kv" } });
    expect(r.warnings[0]).toContain("pnpm approve-builds");
  });

  it("fails when vinext init fails", async () => {
    const { run } = fakeRunner(() => ({ code: 1, output: "incompatible" }));
    await expect(
      nextjsAdapter.convert({ dir: "/w", pm: "pnpm", run, log: () => {}, options: { nextCache: "kv" } }),
    ).rejects.toThrow("exited with code 1");
  });
});

describe("registry", () => {
  it("picks the Next.js adapter and reports others as unsupported for now", () => {
    expect(pickAdapter({ vercelFramework: "nextjs", packageJson: null }).adapter?.id).toBe("nextjs");
    expect(pickAdapter({ vercelFramework: "sveltekit", packageJson: {} })).toEqual({
      adapter: null,
      support: { level: "unsupported", reason: "sveltekit projects aren't supported yet" },
    });
    expect(supportForFramework(null)).toEqual({ level: "unsupported", reason: "Vercel didn't detect a framework" });
    expect(adapterById("nextjs")).toBe(pickAdapter({ vercelFramework: "nextjs", packageJson: null }).adapter);
    expect(adapterById("nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/adapters`
Expected: FAIL, because the modules can't be resolved.

- [ ] **Step 3: Implement the adapters**

`src/adapters/types.ts`:

```ts
import type { CommandRunner } from "../exec.ts";
import type { PackageJson } from "../translate/package-json.ts";
import type { PackageManager } from "../translate/package-manager.ts";

export type SupportLevel = "supported" | "partial" | "unsupported";

export interface Support {
  level: SupportLevel;
  reason?: string;
}

export type NextCachePreset = "kv" | "none";

export interface AdapterOptions {
  nextCache: NextCachePreset;
}

export interface ConvertContext {
  dir: string;
  pm: PackageManager;
  run: CommandRunner;
  log: (line: string) => void;
  options: AdapterOptions;
}

export interface ConvertResult {
  // Module the generated cron entry should wrap.
  baseEntrypoint: string;
  warnings: string[];
}

export interface DetectInput {
  vercelFramework: string | null;
  packageJson: PackageJson | null;
}

export interface Adapter {
  id: string;
  label: string;
  support: Support;
  // Binding names the converter creates, which env vars must not reuse.
  reservedBindings: readonly string[];
  matches(input: DetectInput): boolean;
  convert(ctx: ConvertContext): Promise<ConvertResult>;
}
```

`src/adapters/nextjs.ts`:

```ts
import { VINEXT_VERSION } from "../config.ts";
import { runOrThrow } from "../exec.ts";
import { allDependencies } from "../translate/package-json.ts";
import { dlxCommand } from "../translate/package-manager.ts";
import type { Adapter, NextCachePreset } from "./types.ts";

// vinext refuses to prompt when it detects an agent environment, so every
// choice is passed explicitly. "kv" is the closest match to Vercel's ISR data cache.
export const NEXT_CACHE_FLAGS: Record<NextCachePreset, readonly string[]> = {
  kv: ["--cdn-cache=data-cache", "--data-cache=kv"],
  none: ["--cdn-cache=none", "--data-cache=none"],
};

export const nextjsAdapter: Adapter = {
  id: "nextjs",
  label: "Next.js (vinext)",
  support: { level: "supported" },
  reservedBindings: ["ASSETS", "IMAGES", "VINEXT_KV_CACHE"],
  matches: (input) => input.vercelFramework === "nextjs" || "next" in allDependencies(input.packageJson),
  async convert(ctx) {
    const { cmd, args } = dlxCommand(ctx.pm, `vinext@${VINEXT_VERSION}`, [
      "init",
      "--platform=cloudflare",
      ...NEXT_CACHE_FLAGS[ctx.options.nextCache],
      "--image-optimization=cloudflare-images",
    ]);
    const result = await runOrThrow(ctx.run, cmd, args, { cwd: ctx.dir, onLine: ctx.log });
    const warnings: string[] = [];
    if (result.output.includes("approve-builds")) {
      warnings.push(
        "pnpm blocked some dependency build scripts during install. If the Cloudflare build fails, run `pnpm approve-builds` in the project and commit the result.",
      );
    }
    return { baseEntrypoint: "vinext/server/fetch-handler", warnings };
  },
};
```

`src/adapters/registry.ts`:

```ts
import { nextjsAdapter } from "./nextjs.ts";
import type { Adapter, DetectInput, Support } from "./types.ts";

export const ADAPTERS: readonly Adapter[] = [nextjsAdapter];

const unsupported = (framework: string | null): Support => ({
  level: "unsupported",
  reason: framework ? `${framework} projects aren't supported yet` : "Vercel didn't detect a framework",
});

export function adapterById(id: string | null): Adapter | null {
  return ADAPTERS.find((a) => a.id === id) ?? null;
}

export function pickAdapter(input: DetectInput): { adapter: Adapter | null; support: Support } {
  const adapter = ADAPTERS.find((a) => a.matches(input)) ?? null;
  return adapter ? { adapter, support: adapter.support } : { adapter: null, support: unsupported(input.vercelFramework) };
}

// For the project list, where package.json hasn't been fetched yet.
export function supportForFramework(framework: string | null): Support {
  return pickAdapter({ vercelFramework: framework, packageJson: null }).support;
}
```

- [ ] **Step 4: Run the unit tests**

Run: `pnpm test tests/adapters && pnpm typecheck`
Expected: 6 tests pass.

- [ ] **Step 5: Add the Next.js fixture app**

`tests/fixtures/apps/nextjs-basic/package.json`:

```json
{
  "name": "nextjs-basic",
  "private": true,
  "scripts": { "dev": "next dev", "build": "next build", "start": "next start" },
  "dependencies": { "next": "16.0.0", "react": "19.2.0", "react-dom": "19.2.0" }
}
```

`tests/fixtures/apps/nextjs-basic/app/layout.tsx`:

```tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

`tests/fixtures/apps/nextjs-basic/app/page.tsx`:

```tsx
export default function Page() {
  return <h1>Hello from the fixture</h1>;
}
```

`tests/fixtures/apps/nextjs-basic/app/api/cron/route.ts`:

```ts
export async function GET() {
  return Response.json({ ok: true });
}
```

- [ ] **Step 6: Write the fixture test**

`tests/fixtures/nextjs.fixture.test.ts`:

```ts
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nextjsAdapter } from "../../src/adapters/nextjs.ts";
import { editCloudflareConfig } from "../../src/codegen/config-edit.ts";
import { CRON_ENTRY_FILE, cronEntrySource } from "../../src/codegen/cron-entry.ts";
import { createCommandRunner, runOrThrow } from "../../src/exec.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const FIXTURE = join(import.meta.dirname, "apps", "nextjs-basic");

describe("Next.js fixture", () => {
  it("converts with vinext, applies Switchyard's edits and builds with cf", async () => {
    const dir = await makeTempDir();
    await cp(FIXTURE, dir, { recursive: true });
    const run = createCommandRunner();
    const lines: string[] = [];
    await runOrThrow(run, "git", ["init", "-q"], { cwd: dir });

    const result = await nextjsAdapter.convert({
      dir,
      pm: "pnpm",
      run,
      log: (l) => lines.push(l),
      options: { nextCache: "kv" },
    });

    const crons = [{ path: "/api/cron", schedule: "0 * * * *" }];
    await writeFile(join(dir, CRON_ENTRY_FILE), cronEntrySource(result.baseEntrypoint, crons));
    const configPath = join(dir, "cloudflare.config.ts");
    await writeFile(
      configPath,
      editCloudflareConfig(await readFile(configPath, "utf8"), {
        workerName: "fixture-app",
        secretKeys: ["API_KEY"],
        crons,
        entrypoint: `./${CRON_ENTRY_FILE}`,
      }),
    );

    const build = await run("pnpm", ["exec", "cf", "build"], { cwd: dir, env: { CI: "1" } });
    expect(build.code, `${lines.join("\n")}\n${build.output}`).toBe(0);

    const built = JSON.parse(
      await readFile(join(dir, ".cloudflare/output/v0/workers/default/worker.config.json"), "utf8"),
    ) as { name: string; triggers: unknown[]; env: Record<string, unknown> };
    expect(built.name).toBe("fixture-app");
    expect(built.triggers).toContainEqual({ type: "scheduled", schedule: "0 * * * *" });
    expect(built.env).toHaveProperty("API_KEY");
    expect(built.env).toHaveProperty("VINEXT_KV_CACHE");
  });
});
```

- [ ] **Step 7: Run the fixture test**

Run: `pnpm test:fixtures`
Expected: PASS, after a few minutes on the first run while vinext and its dependencies download.

If `cf build` fails with missing native binaries (esbuild, rolldown or workerd), pnpm's build-script block is the cause:
1. Change `nextjsAdapter.convert` so that, when `ctx.pm === "pnpm"` and the output contains `approve-builds`, it runs `pnpm install --config.dangerously-allow-all-builds=true` in `ctx.dir` after `vinext init`. Keep the warning.
2. Add a unit test asserting that the second command runs.
3. Re-run the fixture.

- [ ] **Step 8: Commit**

```bash
git add src/adapters tests/adapters tests/fixtures
git commit -m "feat: add Next.js adapter using vinext, with a real build fixture"
```

---

### Task 16: Plan builder (phase 1)

**Files:**
- Create: `src/pipeline/plan.ts`
- Test: `tests/pipeline/plan.test.ts`

**Interfaces:**
- Consumes: `VercelClient`, `VercelDomain` (Task 8), `CloudflareClient`, `CloudflareZone` (Task 9), `GitHubClient` (Task 10), `buildEnvPlan` + `EnvPlan` + `EnvValues` (Task 11), `translateVercelJson` + `VercelJsonTranslation` (Task 12), detection helpers (Task 13), `pickAdapter` + `Support` + `NextCachePreset` (Task 15), `ApiError` (Task 2), `MIGRATION_BRANCH` (Task 5).
- Produces:
  - `interface DomainPlan { name: string; zone: string | null }`
  - `interface MigrationPlan { projectId: string; projectName: string; workerName: string; repo: { owner: string; name: string; productionBranch: string; rootDirectory: string } | null; packageManager: PackageManager; adapterId: string | null; support: Support; nextCache: NextCachePreset; env: EnvPlan; vercelJson: VercelJsonTranslation; storage: StorageFinding[]; features: FeatureFinding[]; domains: DomainPlan[]; blockers: string[] }`
  - `interface PlanDeps { vercel: VercelClient; github: GitHubClient; cloudflare: CloudflareClient; accountId: string }`
  - `buildPlan(d: PlanDeps, projectId: string): Promise<{ plan: MigrationPlan; values: EnvValues }>`
  - `sanitizeWorkerName(name: string): string` and `planDomains(domains: VercelDomain[], zones: CloudflareZone[]): DomainPlan[]`

- [ ] **Step 1: Write the failing tests**

`tests/pipeline/plan.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { CloudflareClient } from "../../src/clients/cloudflare.ts";
import type { GitHubClient } from "../../src/clients/github.ts";
import type { VercelClient, VercelProject } from "../../src/clients/vercel.ts";
import { ApiError } from "../../src/http.ts";
import { buildPlan, planDomains, sanitizeWorkerName } from "../../src/pipeline/plan.ts";

const project: VercelProject = {
  id: "prj_1",
  name: "My Shop!",
  framework: "nextjs",
  rootDirectory: "apps/web/",
  link: { type: "github", org: "acme", repo: "shop", repoId: 2, productionBranch: "main" },
};

function deps(over: { project?: VercelProject; github?: Partial<GitHubClient> } = {}) {
  const files: Record<string, string> = {
    "apps/web/package.json": JSON.stringify({ dependencies: { next: "16", "@vercel/blob": "1" } }),
    "apps/web/vercel.json": JSON.stringify({ crons: [{ path: "/api/cron", schedule: "0 * * * *" }] }),
  };
  const vercel = {
    getProject: async () => over.project ?? project,
    listEnv: async () => [
      { id: "e1", key: "API_KEY", value: "secret-1", type: "encrypted", target: ["production"] },
      { id: "e2", key: "TOKEN", type: "sensitive", target: ["production"] },
      { id: "e3", key: "BLOB_READ_WRITE_TOKEN", value: "b", type: "encrypted", target: ["production"] },
    ],
    listDomains: async () => [{ name: "shop.example.com" }, { name: "my-shop.vercel.app" }, { name: "other.io" }],
  } as unknown as VercelClient;
  const github = {
    getRepo: async () => ({ id: 2, name: "shop", ownerId: 1, ownerLogin: "acme", defaultBranch: "main", private: true }),
    getFile: async (_o: string, _r: string, path: string) => files[path] ?? null,
    listDir: async (_o: string, _r: string, path: string) => (path === "" ? ["pnpm-lock.yaml", "apps"] : ["package.json"]),
    ...over.github,
  } as unknown as GitHubClient;
  const cloudflare = {
    listZones: async () => [{ id: "z", name: "example.com" }],
  } as unknown as CloudflareClient;
  return { vercel, github, cloudflare, accountId: "acc" };
}

describe("buildPlan", () => {
  it("builds a complete plan for a Next.js project in a monorepo folder", async () => {
    const { plan, values } = await buildPlan(deps(), "prj_1");
    expect(plan).toMatchObject({
      projectId: "prj_1",
      workerName: "my-shop",
      repo: { owner: "acme", name: "shop", productionBranch: "main", rootDirectory: "apps/web" },
      packageManager: "pnpm",
      adapterId: "nextjs",
      support: { level: "supported" },
      nextCache: "kv",
      blockers: [],
    });
    expect(plan.vercelJson.crons).toEqual([{ path: "/api/cron", schedule: "0 * * * *" }]);
    expect(plan.storage.map((s) => s.kind)).toEqual(["vercel-blob"]);
    expect(plan.env.entries.find((e) => e.key === "TOKEN")?.needsInput).toBe(true);
    expect(plan.domains).toEqual([
      { name: "shop.example.com", zone: "example.com" },
      { name: "other.io", zone: null },
    ]);
    expect(values.e1).toBe("secret-1");
    expect(JSON.stringify(plan)).not.toContain("secret-1");
  });

  it("blocks projects without a Git link or on another provider", async () => {
    const noLink = await buildPlan(deps({ project: { ...project, link: undefined } }), "p");
    expect(noLink.plan.blockers[0]).toContain("isn't linked to a Git repository");
    const gitlab = await buildPlan(
      deps({ project: { ...project, link: { type: "gitlab", org: "a", repo: "b" } } }),
      "p",
    );
    expect(gitlab.plan.blockers[0]).toContain("gitlab");
  });

  it("blocks when the repo can't be reached, naming it", async () => {
    const { plan } = await buildPlan(
      deps({
        github: {
          getRepo: async () => {
            throw new ApiError("github", 404, "Repository acme/shop was not found, or the GitHub token can't access it. … SSO …");
          },
        },
      }),
      "p",
    );
    expect(plan.blockers[0]).toContain("acme/shop");
    expect(plan.blockers[0]).toContain("SSO");
  });

  it("blocks when package.json is missing at the root directory", async () => {
    const { plan } = await buildPlan(deps({ github: { getFile: async () => null } }), "p");
    expect(plan.blockers).toContain("No readable package.json at apps/web on main.");
  });

  it("blocks when the production branch is the migration branch", async () => {
    const { plan } = await buildPlan(
      deps({ project: { ...project, link: { ...project.link!, productionBranch: "cloudflare-migration" } } }),
      "p",
    );
    expect(plan.blockers.some((b) => b.includes("cloudflare-migration"))).toBe(true);
  });

  it("rethrows auth errors so the UI can ask to reconnect", async () => {
    const err = await buildPlan(
      deps({
        github: {
          getRepo: async () => {
            throw new ApiError("github", 401, "Bad credentials", true);
          },
        },
      }),
      "p",
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
  });
});

describe("helpers", () => {
  it("sanitises Worker names", () => {
    expect(sanitizeWorkerName("My Shop!")).toBe("my-shop");
    expect(sanitizeWorkerName("---")).toBe("app");
    expect(sanitizeWorkerName("a".repeat(80))).toHaveLength(63);
  });

  it("matches domains to the longest zone", () => {
    expect(
      planDomains([{ name: "a.b.example.com" }], [
        { id: "1", name: "example.com" },
        { id: "2", name: "b.example.com" },
      ]),
    ).toEqual([{ name: "a.b.example.com", zone: "b.example.com" }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/pipeline/plan.test.ts`
Expected: FAIL, because the module can't be resolved.

- [ ] **Step 3: Implement the plan builder**

`src/pipeline/plan.ts`:

```ts
import { pickAdapter } from "../adapters/registry.ts";
import type { NextCachePreset, Support } from "../adapters/types.ts";
import type { CloudflareClient, CloudflareZone } from "../clients/cloudflare.ts";
import type { GitHubClient } from "../clients/github.ts";
import type { VercelClient, VercelDomain } from "../clients/vercel.ts";
import { MIGRATION_BRANCH } from "../config.ts";
import { ApiError } from "../http.ts";
import { buildEnvPlan, type EnvPlan, type EnvValues } from "../translate/env-plan.ts";
import { detectVercelFeatures, type FeatureFinding } from "../translate/features.ts";
import { allDependencies, parsePackageJson, type PackageJson } from "../translate/package-json.ts";
import { detectPackageManager, type PackageManager } from "../translate/package-manager.ts";
import { detectStorage, type StorageFinding } from "../translate/storage.ts";
import { translateVercelJson, type VercelJsonTranslation } from "../translate/vercel-json.ts";

export interface DomainPlan {
  name: string;
  zone: string | null;
}

export interface MigrationPlan {
  projectId: string;
  projectName: string;
  workerName: string;
  repo: { owner: string; name: string; productionBranch: string; rootDirectory: string } | null;
  packageManager: PackageManager;
  adapterId: string | null;
  support: Support;
  nextCache: NextCachePreset;
  env: EnvPlan;
  vercelJson: VercelJsonTranslation;
  storage: StorageFinding[];
  features: FeatureFinding[];
  domains: DomainPlan[];
  blockers: string[];
}

export interface PlanDeps {
  vercel: VercelClient;
  github: GitHubClient;
  cloudflare: CloudflareClient;
  accountId: string;
}

export function sanitizeWorkerName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return cleaned || "app";
}

export function planDomains(domains: VercelDomain[], zones: CloudflareZone[]): DomainPlan[] {
  const byLength = [...zones].sort((a, b) => b.name.length - a.name.length);
  return domains
    .filter((d) => !d.name.endsWith(".vercel.app"))
    .map((d) => ({
      name: d.name,
      zone: byLength.find((z) => d.name === z.name || d.name.endsWith(`.${z.name}`))?.name ?? null,
    }));
}

// Phase 1: read everything needed to show the plan. Nothing is written anywhere.
export async function buildPlan(d: PlanDeps, projectId: string): Promise<{ plan: MigrationPlan; values: EnvValues }> {
  const project = await d.vercel.getProject(projectId);
  const [envVars, domains, zones] = await Promise.all([
    d.vercel.listEnv(project.id),
    d.vercel.listDomains(project.id),
    d.cloudflare.listZones(d.accountId),
  ]);
  const rootDirectory = (project.rootDirectory ?? "").replace(/^\/+|\/+$/g, "");
  const blockers: string[] = [];
  let repo: MigrationPlan["repo"] = null;
  let pkg: PackageJson | null = null;
  let files: string[] = [];
  let vercelJsonRaw: string | null = null;

  const link = project.link;
  if (!link?.org || !link.repo) {
    blockers.push("This project isn't linked to a Git repository on Vercel, so there is no code to convert.");
  } else if (link.type !== "github") {
    blockers.push(`Only GitHub repositories are supported at this point (this project uses ${link.type}).`);
  } else {
    try {
      const info = await d.github.getRepo(link.org, link.repo);
      const productionBranch = link.productionBranch ?? info.defaultBranch;
      repo = { owner: info.ownerLogin, name: info.name, productionBranch, rootDirectory };
      if (productionBranch === MIGRATION_BRANCH) {
        blockers.push(
          `The production branch is called ${MIGRATION_BRANCH}, which Switchyard uses for its own changes. Rename the production branch first.`,
        );
      }
      const at = (file: string) => (rootDirectory ? `${rootDirectory}/${file}` : file);
      const [pkgText, vercelJson, rootFiles, dirFiles] = await Promise.all([
        d.github.getFile(info.ownerLogin, info.name, at("package.json"), productionBranch),
        d.github.getFile(info.ownerLogin, info.name, at("vercel.json"), productionBranch),
        d.github.listDir(info.ownerLogin, info.name, "", productionBranch),
        rootDirectory ? d.github.listDir(info.ownerLogin, info.name, rootDirectory, productionBranch) : null,
      ]);
      pkg = parsePackageJson(pkgText);
      vercelJsonRaw = vercelJson;
      files = [...(rootFiles ?? []), ...(dirFiles ?? [])];
      if (!pkg) blockers.push(`No readable package.json at ${rootDirectory || "the repository root"} on ${productionBranch}.`);
    } catch (e) {
      if (e instanceof ApiError && !e.auth) blockers.push(e.message);
      else throw e;
    }
  }

  const { adapter, support } = pickAdapter({ vercelFramework: project.framework, packageJson: pkg });
  if (!adapter) blockers.push(support.reason ?? "This framework isn't supported yet.");
  const env = buildEnvPlan(envVars, adapter?.reservedBindings ?? []);
  const dependencies = allDependencies(pkg);

  return {
    plan: {
      projectId: project.id,
      projectName: project.name,
      workerName: sanitizeWorkerName(project.name),
      repo,
      packageManager: detectPackageManager(files, pkg),
      adapterId: adapter?.id ?? null,
      support,
      nextCache: "kv",
      env: env.plan,
      vercelJson: translateVercelJson(vercelJsonRaw),
      storage: detectStorage({ envKeys: envVars.map((v) => v.key), dependencies }),
      features: detectVercelFeatures(dependencies),
      domains: planDomains(domains, zones),
      blockers,
    },
    values: env.values,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/pipeline/plan.test.ts && pnpm typecheck`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/plan.ts tests/pipeline/plan.test.ts
git commit -m "feat: build a read-only migration plan from Vercel, GitHub and Cloudflare"
```

---

### Task 17: Pipeline core (types, job store, events, runner, queue, build status)

**Files:**
- Create: `src/pipeline/types.ts`, `src/pipeline/job-store.ts`, `src/pipeline/events.ts`, `src/pipeline/runner.ts`, `src/pipeline/queue.ts`, `src/pipeline/build-status.ts`
- Test: `tests/pipeline/job-store.test.ts`, `tests/pipeline/runner.test.ts`, `tests/pipeline/build-status.test.ts`, `tests/helpers/sample-plan.ts`

**Interfaces:**
- Consumes: `MigrationPlan` (Task 16), `EnvValues` (Task 11), `Redactor` (Task 1), `writeFileSecure` (Task 3), `isAuthError` and `Service` (Task 2), `CommandError` and `CommandRunner` (Task 7), the clients (Tasks 9 and 10), `Adapter` (Task 15) and `BuildInfo` (Task 9).
- Produces:
  - `STEP_IDS = ["clone", "convert", "build", "deploy", "push", "pr", "builds", "start-build"] as const` and `type StepId`
  - `type StepStatus = "pending" | "running" | "done" | "failed" | "paused"`
  - `interface PauseInfo { reason: string; actionLabel?: string; actionUrl?: string; reconnect?: Service }`
  - `interface StepState { id: StepId; status: StepStatus; error?: string; pause?: PauseInfo; outputs: Record<string, string> }`
  - `type JobStatus = "queued" | "running" | "paused" | "failed" | "done"`
  - `interface Job { id: string; createdAt: string; accountId: string; plan: MigrationPlan; status: JobStatus; steps: StepState[] }`
  - `type JobEvent = { type: "log"; jobId: string; step: StepId; line: string } | { type: "job"; job: Job }`
  - `interface PipelineDeps { run: CommandRunner; cloudflare: CloudflareClient; github(): Promise<GitHubClient>; githubToken(): Promise<string>; cloudflareToken(): Promise<string>; adapter(id: string): Adapter | null; workDir: string; sleep(ms: number): Promise<void>; now(): number }`
  - `interface StepContext { job: Job; values: EnvValues; deps: PipelineDeps; log(line: string): void; addSecret(value: string): void; outputs: Record<string, string>; output(step: StepId): Record<string, string> }`
  - `interface Step { id: StepId; title: string; run(ctx: StepContext): Promise<void> }` and `class PauseError extends Error { pause: PauseInfo }`
  - `interface JobStore { create(plan, accountId, values): Promise<Job>; get(id): Promise<Job | null>; list(): Promise<Job[]>; save(job): Promise<void>; readValues(id): Promise<EnvValues>; deleteValues(id): Promise<void>; appendLog(id, line): Promise<void>; readLog(id): Promise<string>; recoverInterrupted(): Promise<{ failed: string[]; queued: string[] }> }` and `createJobStore(dir, opts?)`
  - `interface JobEvents { emit(e: JobEvent): void; subscribe(jobId: string, fn: (e: JobEvent) => void): () => void }` and `createJobEvents()`
  - `interface RunnerDeps { store: JobStore; events: JobEvents; redactor: Redactor; pipeline: PipelineDeps }`, `runJob(jobId, steps, d): Promise<Job>` and `resetForRetry(job: Job): Job`
  - `interface JobQueue { enqueue(jobId: string): void; idle(): Promise<void> }` and `createJobQueue(run, onError?)`
  - `type BuildState = "running" | "success" | "failure"`, `interpretBuild(b: BuildInfo): BuildState` and `buildDashboardUrl(accountId, workerName, buildUuid): string`

- [ ] **Step 1: Write the failing tests**

`tests/helpers/sample-plan.ts`. This is a complete plan, so later step tests can spread it and override fields:

```ts
import type { MigrationPlan } from "../../src/pipeline/plan.ts";

export const samplePlan: MigrationPlan = {
  projectId: "prj_1",
  projectName: "shop",
  workerName: "shop",
  repo: { owner: "acme", name: "shop", productionBranch: "main", rootDirectory: "" },
  packageManager: "pnpm",
  adapterId: "nextjs",
  support: { level: "supported" },
  nextCache: "kv",
  env: { entries: [], warnings: [] },
  vercelJson: { crons: [], manual: [] },
  storage: [],
  features: [],
  domains: [],
  blockers: [],
};
```

`tests/pipeline/job-store.test.ts`:

```ts
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createJobStore } from "../../src/pipeline/job-store.ts";
import { samplePlan } from "../helpers/sample-plan.ts";
import { makeTempDir } from "../helpers/tmp.ts";

describe("createJobStore", () => {
  it("creates a queued job with every step pending and keeps values in a private file", async () => {
    const dir = await makeTempDir();
    const store = createJobStore(dir);
    const job = await store.create(samplePlan, "acc", { e1: "secret-1" });
    expect(job.status).toBe("queued");
    expect(job.steps.map((s) => [s.id, s.status])).toEqual([
      ["clone", "pending"],
      ["convert", "pending"],
      ["build", "pending"],
      ["deploy", "pending"],
      ["push", "pending"],
      ["pr", "pending"],
      ["builds", "pending"],
      ["start-build", "pending"],
    ]);
    expect(await readFile(join(dir, `${job.id}.json`), "utf8")).not.toContain("secret-1");
    expect((await stat(join(dir, `${job.id}.values.json`))).mode & 0o777).toBe(0o600);
    expect(await store.readValues(job.id)).toEqual({ e1: "secret-1" });
    await store.deleteValues(job.id);
    expect(await store.readValues(job.id)).toEqual({});
  });

  it("rejects ids that aren't UUIDs, so API input can't reach other paths", async () => {
    const store = createJobStore(await makeTempDir());
    expect(await store.get("../credentials")).toBeNull();
  });

  it("lists jobs newest first", async () => {
    let t = 0;
    const store = createJobStore(await makeTempDir(), { now: () => new Date(++t * 1000) });
    const a = await store.create(samplePlan, "acc", {});
    const b = await store.create(samplePlan, "acc", {});
    expect((await store.list()).map((j) => j.id)).toEqual([b.id, a.id]);
  });

  it("appends log lines in order", async () => {
    const store = createJobStore(await makeTempDir());
    const job = await store.create(samplePlan, "acc", {});
    await Promise.all(["one", "two", "three"].map((l) => store.appendLog(job.id, l)));
    expect(await store.readLog(job.id)).toBe("one\ntwo\nthree\n");
  });

  it("marks steps that were running when Switchyard stopped as failed, and reports queued jobs", async () => {
    const store = createJobStore(await makeTempDir());
    const running = await store.create(samplePlan, "acc", {});
    running.status = "running";
    running.steps[1]!.status = "running";
    await store.save(running);
    const queued = await store.create(samplePlan, "acc", {});
    expect(await store.recoverInterrupted()).toEqual({ failed: [running.id], queued: [queued.id] });
    const after = await store.get(running.id);
    expect(after?.status).toBe("failed");
    expect(after?.steps[1]).toMatchObject({ status: "failed", error: expect.stringContaining("stopped") });
  });
});
```

`tests/pipeline/runner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/http.ts";
import { createRedactor } from "../../src/redact.ts";
import { createJobEvents } from "../../src/pipeline/events.ts";
import { createJobStore } from "../../src/pipeline/job-store.ts";
import { createJobQueue } from "../../src/pipeline/queue.ts";
import { resetForRetry, runJob } from "../../src/pipeline/runner.ts";
import { PauseError, type JobEvent, type PipelineDeps, type Step, type StepId } from "../../src/pipeline/types.ts";
import { samplePlan } from "../helpers/sample-plan.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const step = (id: StepId, run: Step["run"]): Step => ({ id, title: id, run });
const ok = (id: StepId) => step(id, async () => {});

async function setup() {
  const store = createJobStore(await makeTempDir());
  const events = createJobEvents();
  const redactor = createRedactor();
  const job = await store.create(samplePlan, "acc", { e1: "super-secret" });
  const seen: JobEvent[] = [];
  events.subscribe(job.id, (e) => seen.push(e));
  return { store, events, redactor, job, seen, deps: { store, events, redactor, pipeline: {} as PipelineDeps } };
}

describe("runJob", () => {
  it("runs steps in order, shares outputs, redacts logs and deletes values when done", async () => {
    const { deps, job, seen, store } = await setup();
    const steps = [
      step("clone", async (ctx) => {
        ctx.outputs.dir = "/w";
        ctx.log(`using ${ctx.values.e1}`);
      }),
      step("convert", async (ctx) => {
        expect(ctx.output("clone").dir).toBe("/w");
      }),
    ];
    const done = await runJob(job.id, steps, deps);
    expect(done.status).toBe("done");
    expect(done.steps.slice(0, 2).map((s) => s.status)).toEqual(["done", "done"]);
    expect(seen).toContainEqual({ type: "log", jobId: job.id, step: "clone", line: "using ***" });
    expect(await store.readLog(job.id)).toContain("[clone] using ***");
    expect(await store.readValues(job.id)).toEqual({});
  });

  it("pauses on PauseError and resumes from that step after a retry", async () => {
    const { deps, job, store } = await setup();
    let attempts = 0;
    const steps = [
      ok("clone"),
      step("convert", async () => {
        attempts++;
        if (attempts === 1) throw new PauseError({ reason: "Install the app", actionUrl: "https://x" });
      }),
    ];
    const paused = await runJob(job.id, steps, deps);
    expect(paused.status).toBe("paused");
    expect(paused.steps[1]).toMatchObject({ status: "paused", pause: { reason: "Install the app" } });
    await store.save(resetForRetry(paused));
    const done = await runJob(job.id, steps, deps);
    expect(done.status).toBe("done");
    expect(attempts).toBe(2);
  });

  it("pauses for reconnection on auth errors", async () => {
    const { deps, job } = await setup();
    const r = await runJob(
      job.id,
      [
        step("clone", async () => {
          throw new ApiError("github", 401, "Bad credentials", true);
        }),
      ],
      deps,
    );
    expect(r.steps[0]?.pause?.reconnect).toBe("github");
  });

  it("fails on other errors with a redacted message and keeps values for the retry", async () => {
    const { deps, job, store } = await setup();
    const r = await runJob(
      job.id,
      [
        step("clone", async () => {
          throw new Error("leaked super-secret");
        }),
      ],
      deps,
    );
    expect(r.status).toBe("failed");
    expect(r.steps[0]?.error).toBe("leaked ***");
    expect(await store.readValues(job.id)).toEqual({ e1: "super-secret" });
  });
});

describe("resetForRetry", () => {
  it("sets failed and paused steps back to pending and leaves done steps alone", async () => {
    const { job } = await setup();
    job.steps[0]!.status = "done";
    job.steps[1]!.status = "failed";
    job.steps[1]!.error = "x";
    job.status = "failed";
    const r = resetForRetry(job);
    expect(r.status).toBe("queued");
    expect(r.steps[0]?.status).toBe("done");
    expect(r.steps[1]).toEqual({ id: "convert", status: "pending", outputs: {} });
  });
});

describe("createJobQueue", () => {
  it("runs jobs one at a time, ignores duplicates and survives errors", async () => {
    const order: string[] = [];
    const errors: string[] = [];
    const queue = createJobQueue(
      async (id) => {
        order.push(`start ${id}`);
        await new Promise((r) => setTimeout(r, 5));
        if (id === "b") throw new Error("boom");
        order.push(`end ${id}`);
      },
      (id) => errors.push(id),
    );
    queue.enqueue("a");
    queue.enqueue("a");
    queue.enqueue("b");
    queue.enqueue("c");
    await queue.idle();
    expect(order).toEqual(["start a", "end a", "start b", "start c", "end c"]);
    expect(errors).toEqual(["b"]);
  });
});
```

`tests/pipeline/build-status.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { interpretBuild } from "../../src/pipeline/build-status.ts";

describe("interpretBuild", () => {
  it("uses build_outcome when present", () => {
    expect(interpretBuild({ build_uuid: "b", status: "stopped", build_outcome: "success" })).toBe("success");
    expect(interpretBuild({ build_uuid: "b", status: "stopped", build_outcome: "fail" })).toBe("failure");
  });

  it("falls back to the status", () => {
    expect(interpretBuild({ build_uuid: "b", status: "running", build_outcome: null })).toBe("running");
    expect(interpretBuild({ build_uuid: "b", status: "queued" })).toBe("running");
    expect(interpretBuild({ build_uuid: "b", status: "stopped" })).toBe("failure");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/pipeline`
Expected: the new test files FAIL because the modules can't be resolved. `plan.test.ts` still passes.

- [ ] **Step 3: Implement the pipeline core**

`src/pipeline/types.ts`:

```ts
import type { Adapter } from "../adapters/types.ts";
import type { CloudflareClient } from "../clients/cloudflare.ts";
import type { GitHubClient } from "../clients/github.ts";
import type { CommandRunner } from "../exec.ts";
import type { Service } from "../http.ts";
import type { EnvValues } from "../translate/env-plan.ts";
import type { MigrationPlan } from "./plan.ts";

export const STEP_IDS = ["clone", "convert", "build", "deploy", "push", "pr", "builds", "start-build"] as const;
export type StepId = (typeof STEP_IDS)[number];
export type StepStatus = "pending" | "running" | "done" | "failed" | "paused";

export interface PauseInfo {
  reason: string;
  actionLabel?: string;
  actionUrl?: string;
  reconnect?: Service;
}

export interface StepState {
  id: StepId;
  status: StepStatus;
  error?: string;
  pause?: PauseInfo;
  outputs: Record<string, string>;
}

export type JobStatus = "queued" | "running" | "paused" | "failed" | "done";

export interface Job {
  id: string;
  createdAt: string;
  accountId: string;
  plan: MigrationPlan;
  status: JobStatus;
  steps: StepState[];
}

export type JobEvent = { type: "log"; jobId: string; step: StepId; line: string } | { type: "job"; job: Job };

export interface PipelineDeps {
  run: CommandRunner;
  cloudflare: CloudflareClient;
  github(): Promise<GitHubClient>;
  githubToken(): Promise<string>;
  cloudflareToken(): Promise<string>;
  adapter(id: string): Adapter | null;
  workDir: string;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface StepContext {
  job: Job;
  values: EnvValues;
  deps: PipelineDeps;
  log(line: string): void;
  addSecret(value: string): void;
  outputs: Record<string, string>;
  output(step: StepId): Record<string, string>;
}

export interface Step {
  id: StepId;
  title: string;
  run(ctx: StepContext): Promise<void>;
}

// Thrown by a step when it needs the user to do something before retrying.
export class PauseError extends Error {
  readonly pause: PauseInfo;

  constructor(pause: PauseInfo) {
    super(pause.reason);
    this.name = "PauseError";
    this.pause = pause;
  }
}
```

`src/pipeline/job-store.ts`:

```ts
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileSecure } from "../fs-secure.ts";
import type { EnvValues } from "../translate/env-plan.ts";
import type { MigrationPlan } from "./plan.ts";
import { STEP_IDS, type Job } from "./types.ts";

export interface JobStore {
  create(plan: MigrationPlan, accountId: string, values: EnvValues): Promise<Job>;
  get(id: string): Promise<Job | null>;
  list(): Promise<Job[]>;
  save(job: Job): Promise<void>;
  readValues(id: string): Promise<EnvValues>;
  deleteValues(id: string): Promise<void>;
  appendLog(id: string, line: string): Promise<void>;
  readLog(id: string): Promise<string>;
  recoverInterrupted(): Promise<{ failed: string[]; queued: string[] }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createJobStore(dir: string, opts: { now?: () => Date; newId?: () => string } = {}): JobStore {
  const now = opts.now ?? (() => new Date());
  const newId = opts.newId ?? randomUUID;
  const logChains = new Map<string, Promise<void>>();
  const jobFile = (id: string) => join(dir, `${id}.json`);
  const valuesFile = (id: string) => join(dir, `${id}.values.json`);
  const logFile = (id: string) => join(dir, `${id}.log`);

  async function readJson<T>(file: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(file, "utf8")) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  const store: JobStore = {
    async create(plan, accountId, values) {
      const job: Job = {
        id: newId(),
        createdAt: now().toISOString(),
        accountId,
        plan,
        status: "queued",
        steps: STEP_IDS.map((id) => ({ id, status: "pending", outputs: {} })),
      };
      await writeFileSecure(valuesFile(job.id), JSON.stringify(values));
      await store.save(job);
      return job;
    },
    async get(id) {
      return UUID.test(id) ? readJson<Job>(jobFile(id)) : null;
    },
    async list() {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const ids = (await readdir(dir))
        .filter((f) => f.endsWith(".json") && !f.endsWith(".values.json"))
        .map((f) => f.slice(0, -".json".length));
      const jobs = (await Promise.all(ids.map((id) => store.get(id)))).filter((j): j is Job => j !== null);
      return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async save(job) {
      await writeFileSecure(jobFile(job.id), JSON.stringify(job, null, 2));
    },
    async readValues(id) {
      return (await readJson<EnvValues>(valuesFile(id))) ?? {};
    },
    async deleteValues(id) {
      await rm(valuesFile(id), { force: true });
    },
    appendLog(id, line) {
      // Chain appends per job so lines land in the order they were logged.
      const next = (logChains.get(id) ?? Promise.resolve()).then(() =>
        appendFile(logFile(id), `${line}\n`, { mode: 0o600 }),
      );
      logChains.set(id, next.catch(() => undefined));
      return next;
    },
    async readLog(id) {
      if (!UUID.test(id)) return "";
      return readFile(logFile(id), "utf8").catch(() => "");
    },
    async recoverInterrupted() {
      const failed: string[] = [];
      const queued: string[] = [];
      for (const job of await store.list()) {
        if (job.status === "queued") queued.push(job.id);
        if (job.status !== "running") continue;
        for (const s of job.steps) {
          if (s.status === "running") {
            s.status = "failed";
            s.error = "Switchyard stopped while this step was running. Retry to run it again.";
          }
        }
        job.status = "failed";
        await store.save(job);
        failed.push(job.id);
      }
      return { failed, queued };
    },
  };
  return store;
}
```

`src/pipeline/events.ts`:

```ts
import type { JobEvent } from "./types.ts";

export interface JobEvents {
  emit(e: JobEvent): void;
  subscribe(jobId: string, fn: (e: JobEvent) => void): () => void;
}

export function createJobEvents(): JobEvents {
  const listeners = new Map<string, Set<(e: JobEvent) => void>>();
  return {
    emit(e) {
      const id = e.type === "job" ? e.job.id : e.jobId;
      for (const fn of listeners.get(id) ?? []) fn(e);
    },
    subscribe(jobId, fn) {
      const set = listeners.get(jobId) ?? new Set();
      set.add(fn);
      listeners.set(jobId, set);
      return () => {
        set.delete(fn);
        if (!set.size) listeners.delete(jobId);
      };
    },
  };
}
```

`src/pipeline/runner.ts`:

```ts
import { CommandError } from "../exec.ts";
import { isAuthError, type Service } from "../http.ts";
import type { Redactor } from "../redact.ts";
import type { JobEvents } from "./events.ts";
import type { JobStore } from "./job-store.ts";
import { PauseError, type Job, type PipelineDeps, type Step, type StepContext } from "./types.ts";

export interface RunnerDeps {
  store: JobStore;
  events: JobEvents;
  redactor: Redactor;
  pipeline: PipelineDeps;
}

const SERVICE_NAMES: Record<Service, string> = { vercel: "Vercel", cloudflare: "Cloudflare", github: "GitHub" };

function describe(e: unknown): string {
  if (e instanceof CommandError) return `${e.message}. The output is in the log above.`;
  return e instanceof Error ? e.message : String(e);
}

// The runner owns the job object while it runs and saves it after every change.
export async function runJob(jobId: string, steps: readonly Step[], d: RunnerDeps): Promise<Job> {
  const job = await d.store.get(jobId);
  if (!job) throw new Error(`Job ${jobId} was not found`);
  const values = await d.store.readValues(jobId);
  for (const v of Object.values(values)) d.redactor.add(v);

  const publish = async () => {
    await d.store.save(job);
    d.events.emit({ type: "job", job });
  };

  job.status = "running";
  await publish();

  for (const step of steps) {
    const state = job.steps.find((s) => s.id === step.id);
    if (!state) throw new Error(`Job ${jobId} has no state for step ${step.id}`);
    if (state.status === "done") continue;

    state.status = "running";
    delete state.error;
    delete state.pause;
    await publish();

    const log = (line: string) => {
      const clean = d.redactor.redact(line);
      void d.store.appendLog(jobId, `[${step.id}] ${clean}`).catch(() => undefined);
      d.events.emit({ type: "log", jobId, step: step.id, line: clean });
    };
    const ctx: StepContext = {
      job,
      values,
      deps: d.pipeline,
      log,
      addSecret: (v) => d.redactor.add(v),
      outputs: state.outputs,
      output: (id) => job.steps.find((s) => s.id === id)?.outputs ?? {},
    };

    try {
      await step.run(ctx);
      state.status = "done";
      await publish();
    } catch (e) {
      if (e instanceof PauseError) {
        state.status = "paused";
        state.pause = { ...e.pause, reason: d.redactor.redact(e.pause.reason) };
        job.status = "paused";
      } else if (isAuthError(e)) {
        state.status = "paused";
        state.pause = {
          reason: `${SERVICE_NAMES[e.service]} needs reconnecting: ${d.redactor.redact(e.message)}`,
          reconnect: e.service,
        };
        job.status = "paused";
      } else {
        state.status = "failed";
        state.error = d.redactor.redact(describe(e));
        job.status = "failed";
      }
      log(state.error ?? state.pause?.reason ?? "Stopped");
      await publish();
      return job;
    }
  }

  job.status = "done";
  await d.store.deleteValues(jobId);
  await publish();
  return job;
}

export function resetForRetry(job: Job): Job {
  return {
    ...job,
    status: "queued",
    steps: job.steps.map((s) =>
      s.status === "failed" || s.status === "paused" ? { id: s.id, status: "pending", outputs: {} } : s,
    ),
  };
}
```

`src/pipeline/queue.ts`:

```ts
export interface JobQueue {
  enqueue(jobId: string): void;
  idle(): Promise<void>;
}

// Runs one job at a time: parallel jobs would share disk, rate limits and the
// user's attention, and the extra complexity isn't worth it at this point.
export function createJobQueue(
  run: (jobId: string) => Promise<unknown>,
  onError: (jobId: string, e: unknown) => void = () => {},
): JobQueue {
  let tail: Promise<void> = Promise.resolve();
  const pending = new Set<string>();
  return {
    enqueue(jobId) {
      if (pending.has(jobId)) return;
      pending.add(jobId);
      tail = tail.then(async () => {
        try {
          await run(jobId);
        } catch (e) {
          onError(jobId, e);
        } finally {
          pending.delete(jobId);
        }
      });
    },
    idle: () => tail,
  };
}
```

`src/pipeline/build-status.ts`:

```ts
import type { BuildInfo } from "../clients/cloudflare.ts";

export type BuildState = "running" | "success" | "failure";

// Status values confirmed by spike 2 (docs/spikes.md). Unknown values count as still running.
const SUCCESS = new Set(["success", "succeeded"]);
const FAILURE = new Set(["fail", "failed", "failure", "cancelled", "canceled", "error", "terminated", "stopped"]);

export function interpretBuild(b: BuildInfo): BuildState {
  const outcome = b.build_outcome?.toLowerCase();
  if (outcome) return SUCCESS.has(outcome) ? "success" : "failure";
  const status = b.status.toLowerCase();
  if (SUCCESS.has(status)) return "success";
  if (FAILURE.has(status)) return "failure";
  return "running";
}

export function buildDashboardUrl(accountId: string, workerName: string, buildUuid: string): string {
  return `https://dash.cloudflare.com/${accountId}/workers/services/view/${workerName}/production/builds/${buildUuid}`;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/pipeline && pnpm typecheck`
Expected: all the pipeline tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline tests/pipeline
git commit -m "feat: add resumable job pipeline with private value storage and redacted logs"
```

---

### Task 18: Repository steps (clone, convert, build)

**Files:**
- Create: `src/pipeline/steps/shared.ts`, `src/pipeline/steps/repo.ts`, `tests/helpers/step-context.ts`
- Test: `tests/pipeline/steps/repo.test.ts`

**Interfaces:**
- Consumes: `Step`, `StepContext`, `PipelineDeps`, `Job` and `StepId` (Task 17), `runOrThrow` and `RunResult` (Task 7), `gitAuthEnv` (Task 7), `editCloudflareConfig`, `cronEntrySource`, `CRON_ENTRY_FILE` and `addGitignoreEntries` (Task 14), `secretKeys` and `devVarsFile` (Task 11), `execCommand` (Task 13), `writeFileSecure` (Task 3) and `MIGRATION_BRANCH` (Task 5).
- Produces:
  - `requireRepo(plan)`, `requireOutput(ctx, step, key): string`, `projectDirFor(repoDir, rootDirectory): string` and `git(ctx, cwd, env?): (args) => Promise<RunResult>`
  - `cloneStep` (outputs `dir`), `convertStep` (outputs `projectDir` and `warnings` as a JSON array string) and `buildStep`
  - the test helper `makeContext(over?)`

- [ ] **Step 1: Write the step-context test helper**

`tests/helpers/step-context.ts`:

```ts
import type { CloudflareClient } from "../../src/clients/cloudflare.ts";
import type { GitHubClient } from "../../src/clients/github.ts";
import type { MigrationPlan } from "../../src/pipeline/plan.ts";
import { STEP_IDS, type Job, type PipelineDeps, type StepContext, type StepId } from "../../src/pipeline/types.ts";
import type { EnvValues } from "../../src/translate/env-plan.ts";
import { fakeRunner } from "./fake-runner.ts";
import { samplePlan } from "./sample-plan.ts";

export function makeContext(
  over: {
    plan?: Partial<MigrationPlan>;
    values?: EnvValues;
    deps?: Partial<PipelineDeps>;
    outputs?: Partial<Record<StepId, Record<string, string>>>;
  } = {},
): { ctx: StepContext; job: Job; logs: string[]; secrets: string[] } {
  const logs: string[] = [];
  const secrets: string[] = [];
  const job: Job = {
    id: "00000000-0000-4000-8000-000000000001",
    createdAt: "2026-10-14T00:00:00.000Z",
    accountId: "acc",
    plan: { ...samplePlan, ...over.plan },
    status: "running",
    steps: STEP_IDS.map((id) => ({ id, status: "pending", outputs: { ...over.outputs?.[id] } })),
  };
  const deps: PipelineDeps = {
    run: fakeRunner().run,
    cloudflare: {} as CloudflareClient,
    github: async () => ({}) as GitHubClient,
    githubToken: async () => "gh-token",
    cloudflareToken: async () => "cf-token",
    adapter: () => null,
    workDir: "/tmp/switchyard-test-work",
    sleep: async () => {},
    now: () => 0,
    ...over.deps,
  };
  const ctx: StepContext = {
    job,
    values: over.values ?? {},
    deps,
    log: (l) => logs.push(l),
    addSecret: (s) => secrets.push(s),
    outputs: {},
    output: (id) => job.steps.find((s) => s.id === id)?.outputs ?? {},
  };
  return { ctx, job, logs, secrets };
}
```

- [ ] **Step 2: Write the failing tests**

`tests/pipeline/steps/repo.test.ts`:

```ts
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapter } from "../../../src/adapters/types.ts";
import { CommandError } from "../../../src/exec.ts";
import { buildStep, cloneStep, convertStep } from "../../../src/pipeline/steps/repo.ts";
import { buildEnvPlan } from "../../../src/translate/env-plan.ts";
import { fakeRunner } from "../../helpers/fake-runner.ts";
import { makeContext } from "../../helpers/step-context.ts";
import { makeTempDir } from "../../helpers/tmp.ts";

const VINEXT_CONFIG = `import { bindings, defineConfig, defineWorker } from "cf/config";

export default defineConfig({
  worker: defineWorker({
    name: "probe",
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-10-14",
    env: { ASSETS: bindings.assets() },
  }),
});
`;

describe("cloneStep", () => {
  it("clones the production branch with header auth and creates the migration branch", async () => {
    const workDir = await makeTempDir();
    const { run, calls } = fakeRunner();
    const { ctx, job, secrets } = makeContext({ deps: { run, workDir } });
    await cloneStep.run(ctx);
    const dir = join(workDir, job.id);
    expect(calls[0]?.args).toEqual([
      "clone",
      "--depth",
      "1",
      "--branch",
      "main",
      "https://github.com/acme/shop.git",
      dir,
    ]);
    expect(calls[0]?.opts?.env?.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(calls[1]).toMatchObject({ args: ["checkout", "-B", "cloudflare-migration", "origin/main"], opts: { cwd: dir } });
    expect(ctx.outputs.dir).toBe(dir);
    expect(secrets).toContain("gh-token");
  });

  it("fetches instead of cloning when the working copy already exists", async () => {
    const workDir = await makeTempDir();
    const { run, calls } = fakeRunner();
    const { ctx, job } = makeContext({ deps: { run, workDir } });
    await mkdir(join(workDir, job.id, ".git"), { recursive: true });
    await cloneStep.run(ctx);
    expect(calls[0]?.args).toEqual(["fetch", "--depth", "1", "origin", "main"]);
  });
});

describe("convertStep", () => {
  it("resets the checkout, runs the adapter and applies Switchyard's edits", async () => {
    const repoDir = await makeTempDir();
    const { run, calls } = fakeRunner();
    const adapter: Adapter = {
      id: "nextjs",
      label: "Next.js",
      support: { level: "supported" },
      reservedBindings: ["ASSETS"],
      matches: () => true,
      async convert(c) {
        await writeFile(join(c.dir, "cloudflare.config.ts"), VINEXT_CONFIG);
        return { baseEntrypoint: "vinext/server/fetch-handler", warnings: ["heads up"] };
      },
    };
    const { plan: env, values } = buildEnvPlan(
      [
        { id: "p", key: "API_KEY", value: "prod", type: "encrypted", target: ["production"] },
        { id: "d", key: "LOCAL", value: "dev", type: "plain", target: ["development"] },
      ],
      ["ASSETS"],
    );
    const { ctx } = makeContext({
      plan: { env, vercelJson: { crons: [{ path: "/api/cron", schedule: "0 * * * *" }], manual: [] } },
      values,
      deps: { run, adapter: () => adapter },
      outputs: { clone: { dir: repoDir } },
    });

    await convertStep.run(ctx);

    expect(calls.map((c) => c.args)).toEqual([
      ["reset", "--hard", "origin/main"],
      ["clean", "-fdx", "-e", "node_modules"],
    ]);
    const config = await readFile(join(repoDir, "cloudflare.config.ts"), "utf8");
    expect(config).toContain('name: "shop"');
    expect(config).toContain("API_KEY: bindings.secret()");
    expect(config).toContain('entrypoint: "./switchyard-entry.ts"');
    expect(await readFile(join(repoDir, "switchyard-entry.ts"), "utf8")).toContain('"/api/cron"');
    expect(await readFile(join(repoDir, ".dev.vars"), "utf8")).toBe('LOCAL="dev"\n');
    expect((await stat(join(repoDir, ".dev.vars"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(repoDir, ".gitignore"), "utf8")).toContain(".dev.vars");
    expect(ctx.outputs).toEqual({ projectDir: repoDir, warnings: '["heads up"]' });
  });

  it("works inside the project's root directory", async () => {
    const repoDir = await makeTempDir();
    await mkdir(join(repoDir, "apps/web"), { recursive: true });
    const adapter = {
      convert: async (c: { dir: string }) => {
        await writeFile(join(c.dir, "cloudflare.config.ts"), VINEXT_CONFIG);
        return { baseEntrypoint: "x", warnings: [] };
      },
    } as unknown as Adapter;
    const { ctx } = makeContext({
      plan: { repo: { owner: "acme", name: "shop", productionBranch: "main", rootDirectory: "apps/web" } },
      deps: { adapter: () => adapter },
      outputs: { clone: { dir: repoDir } },
    });
    await convertStep.run(ctx);
    expect(ctx.outputs.projectDir).toBe(join(repoDir, "apps/web"));
  });

  it("fails clearly when the converter produced no cloudflare.config.ts", async () => {
    const repoDir = await makeTempDir();
    const adapter = { convert: async () => ({ baseEntrypoint: "x", warnings: [] }) } as unknown as Adapter;
    const { ctx } = makeContext({ deps: { adapter: () => adapter }, outputs: { clone: { dir: repoDir } } });
    await expect(convertStep.run(ctx)).rejects.toThrow("didn't create cloudflare.config.ts");
  });
});

describe("buildStep", () => {
  it("runs cf build through the project's package manager", async () => {
    const { run, calls } = fakeRunner();
    const { ctx } = makeContext({ deps: { run }, outputs: { convert: { projectDir: "/w/app" } } });
    await buildStep.run(ctx);
    expect(calls[0]).toMatchObject({ cmd: "pnpm", args: ["exec", "cf", "build"], opts: { cwd: "/w/app", env: { CI: "1" } } });
  });

  it("fails with the command's output when the build fails", async () => {
    const { run } = fakeRunner(() => ({ code: 1, output: "Type error" }));
    const { ctx } = makeContext({ deps: { run }, outputs: { convert: { projectDir: "/w/app" } } });
    await expect(buildStep.run(ctx)).rejects.toBeInstanceOf(CommandError);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test tests/pipeline/steps/repo.test.ts`
Expected: FAIL, because the modules can't be resolved.

- [ ] **Step 4: Implement the steps**

`src/pipeline/steps/shared.ts`:

```ts
import { join } from "node:path";
import { runOrThrow, type RunResult } from "../../exec.ts";
import type { MigrationPlan } from "../plan.ts";
import type { StepContext, StepId } from "../types.ts";

export function requireRepo(plan: MigrationPlan): NonNullable<MigrationPlan["repo"]> {
  if (!plan.repo) throw new Error("This plan has no repository to work on.");
  return plan.repo;
}

export function requireOutput(ctx: StepContext, step: StepId, key: string): string {
  const value = ctx.output(step)[key];
  if (!value) throw new Error(`The ${step} step didn't record ${key}. Retry from that step.`);
  return value;
}

export function projectDirFor(repoDir: string, rootDirectory: string): string {
  return rootDirectory ? join(repoDir, rootDirectory) : repoDir;
}

export function git(ctx: StepContext, cwd: string, env: Record<string, string> = {}) {
  return (args: readonly string[]): Promise<RunResult> =>
    runOrThrow(ctx.deps.run, "git", args, { cwd, env, onLine: ctx.log });
}
```

`src/pipeline/steps/repo.ts`:

```ts
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitAuthEnv } from "../../auth/github.ts";
import { editCloudflareConfig } from "../../codegen/config-edit.ts";
import { CRON_ENTRY_FILE, cronEntrySource } from "../../codegen/cron-entry.ts";
import { addGitignoreEntries } from "../../codegen/gitignore.ts";
import { MIGRATION_BRANCH } from "../../config.ts";
import { runOrThrow } from "../../exec.ts";
import { writeFileSecure } from "../../fs-secure.ts";
import { devVarsFile, secretKeys } from "../../translate/env-plan.ts";
import { execCommand } from "../../translate/package-manager.ts";
import type { Step } from "../types.ts";
import { git, projectDirFor, requireOutput, requireRepo } from "./shared.ts";

export const cloneStep: Step = {
  id: "clone",
  title: "Clone the repository",
  async run(ctx) {
    const repo = requireRepo(ctx.job.plan);
    const dir = join(ctx.deps.workDir, ctx.job.id);
    const token = await ctx.deps.githubToken();
    ctx.addSecret(token);
    const authed = git(ctx, dir, gitAuthEnv(token));

    if (existsSync(join(dir, ".git"))) {
      await authed(["fetch", "--depth", "1", "origin", repo.productionBranch]);
    } else {
      await rm(dir, { recursive: true, force: true });
      await mkdir(ctx.deps.workDir, { recursive: true });
      await runOrThrow(
        ctx.deps.run,
        "git",
        [
          "clone",
          "--depth",
          "1",
          "--branch",
          repo.productionBranch,
          `https://github.com/${repo.owner}/${repo.name}.git`,
          dir,
        ],
        { env: gitAuthEnv(token), onLine: ctx.log },
      );
    }
    await git(ctx, dir)(["checkout", "-B", MIGRATION_BRANCH, `origin/${repo.productionBranch}`]);
    ctx.outputs.dir = dir;
  },
};

export const convertStep: Step = {
  id: "convert",
  title: "Convert the project",
  async run(ctx) {
    const { plan } = ctx.job;
    const repo = requireRepo(plan);
    const repoDir = requireOutput(ctx, "clone", "dir");
    const local = git(ctx, repoDir);
    // Start from a clean checkout every time, so a retry never edits twice.
    await local(["reset", "--hard", `origin/${repo.productionBranch}`]);
    await local(["clean", "-fdx", "-e", "node_modules"]);

    const adapter = ctx.deps.adapter(plan.adapterId ?? "");
    if (!adapter) throw new Error(`There is no converter for ${plan.adapterId ?? "this framework"}.`);
    const dir = projectDirFor(repoDir, repo.rootDirectory);
    const result = await adapter.convert({
      dir,
      pm: plan.packageManager,
      run: ctx.deps.run,
      log: ctx.log,
      options: { nextCache: plan.nextCache },
    });
    for (const w of result.warnings) ctx.log(`Warning: ${w}`);

    const configPath = join(dir, "cloudflare.config.ts");
    const source = await readFile(configPath, "utf8").catch(() => {
      throw new Error("The converter didn't create cloudflare.config.ts.");
    });
    const crons = plan.vercelJson.crons;
    if (crons.length) await writeFile(join(dir, CRON_ENTRY_FILE), cronEntrySource(result.baseEntrypoint, crons));
    await writeFile(
      configPath,
      editCloudflareConfig(source, {
        workerName: plan.workerName,
        secretKeys: secretKeys(plan.env),
        crons,
        entrypoint: crons.length ? `./${CRON_ENTRY_FILE}` : undefined,
      }),
    );

    const gitignorePath = join(dir, ".gitignore");
    const gitignore = await readFile(gitignorePath, "utf8").catch(() => "");
    await writeFile(gitignorePath, addGitignoreEntries(gitignore, ["node_modules/", ".dev.vars", ".cloudflare/"]));

    const devVars = devVarsFile(plan.env, ctx.values);
    if (devVars) await writeFileSecure(join(dir, ".dev.vars"), devVars);

    ctx.outputs.projectDir = dir;
    ctx.outputs.warnings = JSON.stringify(result.warnings);
  },
};

export const buildStep: Step = {
  id: "build",
  title: "Build locally with cf",
  async run(ctx) {
    const dir = requireOutput(ctx, "convert", "projectDir");
    const { cmd, args } = execCommand(ctx.job.plan.packageManager, "cf", ["build"]);
    await runOrThrow(ctx.deps.run, cmd, args, { cwd: dir, onLine: ctx.log, env: { CI: "1" } });
  },
};
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test tests/pipeline/steps/repo.test.ts && pnpm typecheck`
Expected: 7 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/steps tests/pipeline/steps tests/helpers/step-context.ts
git commit -m "feat: add clone, convert and local build pipeline steps"
```

---

### Task 19: Release steps (deploy, push, PR)

**Files:**
- Create: `src/pipeline/steps/release.ts`
- Test: `tests/pipeline/steps/release.test.ts`

**Interfaces:**
- Consumes: the helpers from `shared.ts` (Task 18), `runtimeSecrets` (Task 11), `execCommand` (Task 13), `gitAuthEnv` (Task 7), `prBody` (Task 14), `writeFileSecure` (Task 3), `MIGRATION_BRANCH` (Task 5), and `CloudflareClient.getWorkerTag` and `GitHubClient.findOpenPr`/`createPr` (Tasks 9 and 10).
- Produces:
  - `deployStep` (outputs `workersDevUrl` when printed, and `workerTag`)
  - `pushStep` (outputs `branch`)
  - `prStep` (outputs `prUrl`)

- [ ] **Step 1: Write the failing tests**

`tests/pipeline/steps/release.test.ts`:

```ts
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { CloudflareClient } from "../../../src/clients/cloudflare.ts";
import type { GitHubClient } from "../../../src/clients/github.ts";
import { deployStep, prStep, pushStep } from "../../../src/pipeline/steps/release.ts";
import { buildEnvPlan } from "../../../src/translate/env-plan.ts";
import { fakeRunner } from "../../helpers/fake-runner.ts";
import { makeContext } from "../../helpers/step-context.ts";
import { makeTempDir } from "../../helpers/tmp.ts";

describe("deployStep", () => {
  const { plan: env, values } = buildEnvPlan(
    [{ id: "p", key: "API_KEY", value: "prod-secret", type: "encrypted", target: ["production"] }],
    [],
  );

  it("deploys with the OAuth token and a temporary secrets file, then records the Worker", async () => {
    const workDir = await makeTempDir();
    let secretsPath = "";
    let secretsContent = "";
    const { run, calls } = fakeRunner(async (_cmd, args) => {
      secretsPath = args[args.indexOf("--secrets-file") + 1] ?? "";
      secretsContent = await readFile(secretsPath, "utf8");
      return { code: 0, output: "Deployed shop\n  https://shop.acme.workers.dev\n" };
    });
    const cloudflare = { getWorkerTag: vi.fn(async () => "tag-1") } as unknown as CloudflareClient;
    const { ctx, secrets } = makeContext({
      plan: { env },
      values,
      deps: { run, workDir, cloudflare },
      outputs: { convert: { projectDir: "/w/app" } },
    });

    await deployStep.run(ctx);

    expect(calls[0]).toMatchObject({
      cmd: "pnpm",
      opts: { cwd: "/w/app", env: { CI: "1", CLOUDFLARE_API_TOKEN: "cf-token", CLOUDFLARE_ACCOUNT_ID: "acc" } },
    });
    expect(calls[0]?.args.slice(0, 3)).toEqual(["exec", "cf", "deploy"]);
    expect(JSON.parse(secretsContent)).toEqual({ API_KEY: "prod-secret" });
    expect(existsSync(secretsPath)).toBe(false);
    expect(secrets).toContain("cf-token");
    expect(ctx.outputs).toEqual({ workersDevUrl: "https://shop.acme.workers.dev", workerTag: "tag-1" });
    expect(cloudflare.getWorkerTag).toHaveBeenCalledWith("acc", "shop");
  });

  it("removes the secrets file even when the deploy fails", async () => {
    const workDir = await makeTempDir();
    let secretsPath = "";
    const { run } = fakeRunner((_cmd, args) => {
      secretsPath = args[args.indexOf("--secrets-file") + 1] ?? "";
      return { code: 1, output: "Authentication error" };
    });
    const { ctx } = makeContext({ plan: { env }, values, deps: { run, workDir }, outputs: { convert: { projectDir: "/w" } } });
    await expect(deployStep.run(ctx)).rejects.toThrow();
    expect(existsSync(secretsPath)).toBe(false);
  });

  it("skips the secrets file when there are no runtime secrets", async () => {
    const { run, calls } = fakeRunner(() => ({ code: 0, output: "" }));
    const cloudflare = { getWorkerTag: async () => "tag-1" } as unknown as CloudflareClient;
    const { ctx } = makeContext({ deps: { run, cloudflare }, outputs: { convert: { projectDir: "/w" } } });
    await deployStep.run(ctx);
    expect(calls[0]?.args).not.toContain("--secrets-file");
  });

  it("fails when the Worker can't be found after deploying", async () => {
    const { run } = fakeRunner(() => ({ code: 0, output: "" }));
    const cloudflare = { getWorkerTag: async () => null } as unknown as CloudflareClient;
    const { ctx } = makeContext({ deps: { run, cloudflare }, outputs: { convert: { projectDir: "/w" } } });
    await expect(deployStep.run(ctx)).rejects.toThrow("wasn't found");
  });
});

describe("pushStep", () => {
  it("commits changes and force-pushes only the migration branch", async () => {
    const { run, calls } = fakeRunner((_cmd, args) => ({
      code: 0,
      output: args[0] === "status" ? " M package.json\n" : "",
    }));
    const { ctx } = makeContext({ deps: { run }, outputs: { clone: { dir: "/w" } } });
    await pushStep.run(ctx);
    expect(calls.map((c) => c.args[0])).toEqual(["add", "status", "commit", "push"]);
    expect(calls[3]?.args).toEqual(["push", "--force", "origin", "HEAD:refs/heads/cloudflare-migration"]);
    expect(calls[3]?.opts?.env?.GIT_CONFIG_KEY_0).toBeDefined();
    expect(ctx.outputs.branch).toBe("cloudflare-migration");
  });

  it("doesn't create an empty commit on a retry", async () => {
    const { run, calls } = fakeRunner(() => ({ code: 0, output: "" }));
    const { ctx } = makeContext({ deps: { run }, outputs: { clone: { dir: "/w" } } });
    await pushStep.run(ctx);
    expect(calls.map((c) => c.args[0])).toEqual(["add", "status", "push"]);
  });
});

describe("prStep", () => {
  it("reuses an open PR", async () => {
    const gh = {
      findOpenPr: vi.fn(async () => ({ url: "https://github.com/acme/shop/pull/3", number: 3 })),
      createPr: vi.fn(),
    } as unknown as GitHubClient;
    const { ctx } = makeContext({ deps: { github: async () => gh } });
    await prStep.run(ctx);
    expect(ctx.outputs.prUrl).toBe("https://github.com/acme/shop/pull/3");
    expect(gh.createPr).not.toHaveBeenCalled();
  });

  it("opens a PR against the production branch with the deploy link in the body", async () => {
    const createPr = vi.fn(async () => ({ url: "https://github.com/acme/shop/pull/4", number: 4 }));
    const gh = { findOpenPr: async () => null, createPr } as unknown as GitHubClient;
    const { ctx } = makeContext({
      deps: { github: async () => gh },
      outputs: { deploy: { workersDevUrl: "https://shop.acme.workers.dev" }, convert: { warnings: '["w1"]' } },
    });
    await prStep.run(ctx);
    const [owner, repo, input] = createPr.mock.calls[0] as unknown as [string, string, { head: string; base: string; title: string; body: string }];
    expect([owner, repo, input.head, input.base]).toEqual(["acme", "shop", "cloudflare-migration", "main"]);
    expect(input.title).toBe("Move shop from Vercel to Cloudflare Workers");
    expect(input.body).toContain("https://shop.acme.workers.dev");
    expect(input.body).toContain("- [ ] w1");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/pipeline/steps/release.test.ts`
Expected: FAIL, because the module can't be resolved.

- [ ] **Step 3: Implement the steps**

`src/pipeline/steps/release.ts`:

```ts
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { gitAuthEnv } from "../../auth/github.ts";
import { prBody } from "../../codegen/pr-body.ts";
import { MIGRATION_BRANCH } from "../../config.ts";
import { runOrThrow } from "../../exec.ts";
import { writeFileSecure } from "../../fs-secure.ts";
import { runtimeSecrets } from "../../translate/env-plan.ts";
import { execCommand } from "../../translate/package-manager.ts";
import type { Step } from "../types.ts";
import { git, requireOutput, requireRepo } from "./shared.ts";

const WORKERS_DEV = /https:\/\/[a-z0-9.-]+\.workers\.dev/i;

export const deployStep: Step = {
  id: "deploy",
  title: "Create the Worker with a first deploy",
  async run(ctx) {
    const { plan, accountId } = ctx.job;
    const dir = requireOutput(ctx, "convert", "projectDir");
    const token = await ctx.deps.cloudflareToken();
    ctx.addSecret(token);

    const secrets = runtimeSecrets(plan.env, ctx.values);
    const hasSecrets = Object.keys(secrets).length > 0;
    // Outside the repository, so it can never be committed.
    const secretsFile = join(ctx.deps.workDir, `${ctx.job.id}.secrets.json`);
    const args = ["deploy", "--message", "First deploy by Switchyard"];
    if (hasSecrets) {
      await writeFileSecure(secretsFile, JSON.stringify(secrets));
      args.push("--secrets-file", secretsFile);
    }

    try {
      const { cmd, args: full } = execCommand(plan.packageManager, "cf", args);
      const result = await runOrThrow(ctx.deps.run, cmd, full, {
        cwd: dir,
        onLine: ctx.log,
        env: { CI: "1", CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId },
      });
      const url = result.output.match(WORKERS_DEV)?.[0];
      if (url) ctx.outputs.workersDevUrl = url;
    } finally {
      if (hasSecrets) await rm(secretsFile, { force: true });
    }

    const tag = await ctx.deps.cloudflare.getWorkerTag(accountId, plan.workerName);
    if (!tag) throw new Error(`The Worker ${plan.workerName} wasn't found on the account after deploying.`);
    ctx.outputs.workerTag = tag;
  },
};

export const pushStep: Step = {
  id: "push",
  title: "Push the migration branch",
  async run(ctx) {
    const repoDir = requireOutput(ctx, "clone", "dir");
    const token = await ctx.deps.githubToken();
    ctx.addSecret(token);
    const local = git(ctx, repoDir);

    await local(["add", "-A"]);
    const status = await runOrThrow(ctx.deps.run, "git", ["status", "--porcelain"], { cwd: repoDir });
    if (status.output.trim()) {
      await local([
        "commit",
        "-m",
        "chore: move hosting from Vercel to Cloudflare Workers",
        "-m",
        "Converted by Switchyard. The pull request lists the remaining steps.",
      ]);
    }
    // The refspec is fixed: this is the only branch Switchyard ever pushes to.
    await git(ctx, repoDir, gitAuthEnv(token))(["push", "--force", "origin", `HEAD:refs/heads/${MIGRATION_BRANCH}`]);
    ctx.outputs.branch = MIGRATION_BRANCH;
  },
};

export const prStep: Step = {
  id: "pr",
  title: "Open the pull request",
  async run(ctx) {
    const { plan } = ctx.job;
    const repo = requireRepo(plan);
    const gh = await ctx.deps.github();
    const existing = await gh.findOpenPr(repo.owner, repo.name, MIGRATION_BRANCH);
    const warnings = JSON.parse(ctx.output("convert").warnings ?? "[]") as string[];
    const pr =
      existing ??
      (await gh.createPr(repo.owner, repo.name, {
        title: `Move ${plan.projectName} from Vercel to Cloudflare Workers`,
        head: MIGRATION_BRANCH,
        base: repo.productionBranch,
        body: prBody({
          projectName: plan.projectName,
          productionBranch: repo.productionBranch,
          workersDevUrl: ctx.output("deploy").workersDevUrl,
          hasCrons: plan.vercelJson.crons.length > 0,
          skippedEnv: plan.env.entries.flatMap((e) => (e.skipReason ? [{ key: e.key, reason: e.skipReason }] : [])),
          manual: plan.vercelJson.manual,
          features: plan.features,
          storage: plan.storage,
          warnings,
        }),
      }));
    ctx.outputs.prUrl = pr.url;
    ctx.log(existing ? `Using the open pull request ${pr.url}` : `Opened ${pr.url}`);
  },
};
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/pipeline/steps/release.test.ts && pnpm typecheck`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/steps/release.ts tests/pipeline/steps/release.test.ts
git commit -m "feat: add deploy, push and pull request pipeline steps"
```

---

### Task 20: Workers Builds steps and the step list

**Files:**
- Create: `src/pipeline/steps/builds.ts`, `src/pipeline/steps/index.ts`
- Test: `tests/pipeline/steps/builds.test.ts`

**Interfaces:**
- Consumes: `CloudflareClient`, `TriggerInput` and `BuildTrigger` (Task 9), `GitHubClient.getRepo` (Task 10), `triggerVariables` (Task 11), `execString` (Task 13), `interpretBuild` and `buildDashboardUrl` (Task 17), `PauseError` (Task 17), `ApiError` (Task 2), and `PRODUCTION_TRIGGER`, `PREVIEW_TRIGGER`, `GITHUB_APP_INSTALL_URL` and `MIGRATION_BRANCH` (Task 5).
- Produces:
  - `buildsStep` (outputs `productionTrigger` and `previewTrigger`)
  - `startBuildStep` (outputs `buildUuid` and `buildUrl`)
  - `PREVIEW_DEPLOY_COMMAND`
  - `STEPS: readonly Step[]`, in `STEP_IDS` order

- [ ] **Step 1: Write the failing tests**

`tests/pipeline/steps/builds.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { BuildInfo, CloudflareClient, TriggerInput } from "../../../src/clients/cloudflare.ts";
import type { GitHubClient } from "../../../src/clients/github.ts";
import { ApiError } from "../../../src/http.ts";
import { buildsStep, PREVIEW_DEPLOY_COMMAND, startBuildStep } from "../../../src/pipeline/steps/builds.ts";
import { STEPS } from "../../../src/pipeline/steps/index.ts";
import { PauseError, STEP_IDS } from "../../../src/pipeline/types.ts";
import { buildEnvPlan } from "../../../src/translate/env-plan.ts";
import { makeContext } from "../../helpers/step-context.ts";

const github = {
  getRepo: async () => ({ id: 22, name: "shop", ownerId: 11, ownerLogin: "acme", defaultBranch: "main", private: true }),
} as unknown as GitHubClient;

function cloudflare(over: Partial<CloudflareClient> = {}) {
  const created: TriggerInput[] = [];
  const envCalls: [string, Record<string, unknown>][] = [];
  const cf = {
    putRepoConnection: vi.fn(async () => "rc-1"),
    listBuildTokens: async () => [{ build_token_uuid: "bt-1", build_token_name: "Workers Builds" }],
    listTriggers: async () => [],
    createTrigger: async (_a: string, input: TriggerInput) => {
      created.push(input);
      return { trigger_uuid: `tr-${created.length}`, trigger_name: input.trigger_name };
    },
    setTriggerEnv: async (_a: string, uuid: string, vars: Record<string, unknown>) => {
      envCalls.push([uuid, vars]);
    },
    ...over,
  } as unknown as CloudflareClient;
  return { cf, created, envCalls };
}

const { plan: env, values } = buildEnvPlan(
  [
    { id: "p", key: "API_KEY", value: "prod", type: "encrypted", target: ["production"] },
    { id: "v", key: "API_KEY", value: "prev", type: "encrypted", target: ["preview"] },
  ],
  [],
);

describe("buildsStep", () => {
  it("connects the repo and creates production and preview triggers with build variables", async () => {
    const { cf, created, envCalls } = cloudflare();
    const { ctx } = makeContext({
      plan: { env, repo: { owner: "acme", name: "shop", productionBranch: "main", rootDirectory: "apps/web" } },
      values,
      deps: { cloudflare: cf, github: async () => github },
      outputs: { deploy: { workerTag: "tag-1" } },
    });
    await buildsStep.run(ctx);

    expect(cf.putRepoConnection).toHaveBeenCalledWith("acc", {
      provider_type: "github",
      provider_account_id: "11",
      provider_account_name: "acme",
      repo_id: "22",
      repo_name: "shop",
    });
    expect(created[0]).toMatchObject({
      external_script_id: "tag-1",
      repo_connection_uuid: "rc-1",
      build_token_uuid: "bt-1",
      trigger_name: "switchyard-production",
      build_command: "pnpm exec cf build",
      deploy_command: "pnpm exec cf deploy --prebuilt",
      root_directory: "/apps/web",
      branch_includes: ["main"],
      branch_excludes: [],
    });
    expect(created[1]).toMatchObject({
      trigger_name: "switchyard-preview",
      deploy_command: PREVIEW_DEPLOY_COMMAND,
      branch_includes: ["*"],
      branch_excludes: ["main"],
    });
    expect(envCalls).toEqual([
      ["tr-1", { API_KEY: { value: "prod", is_secret: true } }],
      ["tr-2", { API_KEY: { value: "prev", is_secret: true } }],
    ]);
    expect(ctx.outputs).toEqual({ productionTrigger: "tr-1", previewTrigger: "tr-2" });
  });

  it("reuses triggers that already exist", async () => {
    const { cf, created } = cloudflare({
      listTriggers: async () => [
        { trigger_uuid: "old-1", trigger_name: "switchyard-production" },
        { trigger_uuid: "old-2", trigger_name: "switchyard-preview" },
      ],
    });
    const { ctx } = makeContext({ deps: { cloudflare: cf, github: async () => github }, outputs: { deploy: { workerTag: "t" } } });
    await buildsStep.run(ctx);
    expect(created).toEqual([]);
    expect(ctx.outputs).toEqual({ productionTrigger: "old-1", previewTrigger: "old-2" });
  });

  it("pauses with the GitHub App link when Cloudflare can't see the repo", async () => {
    const { cf } = cloudflare({
      putRepoConnection: async () => {
        throw new ApiError("cloudflare", 400, "repository not accessible");
      },
    });
    const { ctx } = makeContext({ deps: { cloudflare: cf, github: async () => github }, outputs: { deploy: { workerTag: "t" } } });
    const err = await buildsStep.run(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PauseError);
    expect((err as PauseError).pause.actionUrl).toBe("https://github.com/apps/cloudflare-workers-and-pages/installations/new");
  });

  it("pauses when the account has no build token", async () => {
    const { cf } = cloudflare({ listBuildTokens: async () => [] });
    const { ctx } = makeContext({ deps: { cloudflare: cf, github: async () => github }, outputs: { deploy: { workerTag: "t" } } });
    const err = await buildsStep.run(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PauseError);
    expect((err as PauseError).pause.reason).toContain("Builds token");
  });
});

describe("startBuildStep", () => {
  function withBuilds(states: BuildInfo[], now: () => number = () => 0) {
    const cf = {
      startBuild: vi.fn(async () => "b-1"),
      getBuild: vi.fn(async () => states.shift() ?? { build_uuid: "b-1", status: "running" }),
    } as unknown as CloudflareClient;
    return makeContext({ deps: { cloudflare: cf, now }, outputs: { builds: { previewTrigger: "tr-2" } } });
  }

  it("starts a build of the migration branch and waits for success", async () => {
    const { ctx, logs } = withBuilds([
      { build_uuid: "b-1", status: "queued" },
      { build_uuid: "b-1", status: "running" },
      { build_uuid: "b-1", status: "stopped", build_outcome: "success" },
    ]);
    await startBuildStep.run(ctx);
    expect(ctx.deps.cloudflare.startBuild).toHaveBeenCalledWith("acc", "tr-2", "cloudflare-migration");
    expect(ctx.outputs.buildUuid).toBe("b-1");
    expect(ctx.outputs.buildUrl).toContain("/builds/b-1");
    expect(logs.filter((l) => l.startsWith("Build status"))).toHaveLength(3);
  });

  it("fails with a link to the build log when the build fails", async () => {
    const { ctx } = withBuilds([{ build_uuid: "b-1", status: "stopped", build_outcome: "fail" }]);
    await expect(startBuildStep.run(ctx)).rejects.toThrow(/finished with "fail".*builds\/b-1/);
  });

  it("gives up after 30 minutes", async () => {
    let t = 0;
    const { ctx } = withBuilds([], () => (t += 11 * 60_000));
    await expect(startBuildStep.run(ctx)).rejects.toThrow("still running after 30 minutes");
  });
});

describe("STEPS", () => {
  it("lists every step in pipeline order", () => {
    expect(STEPS.map((s) => s.id)).toEqual([...STEP_IDS]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/pipeline/steps/builds.test.ts`
Expected: FAIL, because the modules can't be resolved.

- [ ] **Step 3: Implement the steps**

`src/pipeline/steps/builds.ts`:

```ts
import type { BuildTrigger, TriggerInput } from "../../clients/cloudflare.ts";
import { GITHUB_APP_INSTALL_URL, MIGRATION_BRANCH, PREVIEW_TRIGGER, PRODUCTION_TRIGGER } from "../../config.ts";
import { ApiError } from "../../http.ts";
import { triggerVariables } from "../../translate/env-plan.ts";
import { execString } from "../../translate/package-manager.ts";
import { buildDashboardUrl, interpretBuild } from "../build-status.ts";
import { PauseError, type Step } from "../types.ts";
import { requireOutput, requireRepo } from "./shared.ts";

// Preview branches are built to prove they compile, but never deployed, so they
// can't replace production. Spike 2 records whether cf can upload previews.
export const PREVIEW_DEPLOY_COMMAND = 'echo "Switchyard: preview branches are built but not deployed"';

const BUILD_TIMEOUT_MS = 30 * 60_000;
const POLL_MS = 10_000;

export const buildsStep: Step = {
  id: "builds",
  title: "Connect Workers Builds",
  async run(ctx) {
    const { plan, accountId } = ctx.job;
    const repo = requireRepo(plan);
    const workerTag = requireOutput(ctx, "deploy", "workerTag");
    const cf = ctx.deps.cloudflare;
    const info = await (await ctx.deps.github()).getRepo(repo.owner, repo.name);

    let connection: string;
    try {
      connection = await cf.putRepoConnection(accountId, {
        provider_type: "github",
        provider_account_id: String(info.ownerId),
        provider_account_name: info.ownerLogin,
        repo_id: String(info.id),
        repo_name: info.name,
      });
    } catch (e) {
      if (e instanceof ApiError && !e.auth && e.status >= 400 && e.status < 500) {
        throw new PauseError({
          reason: `Cloudflare couldn't connect to ${repo.owner}/${repo.name}. Install the Cloudflare Workers and Pages GitHub App on ${repo.owner} with access to this repository, then select Check again. (${e.message})`,
          actionLabel: "Install the GitHub App",
          actionUrl: GITHUB_APP_INSTALL_URL,
        });
      }
      throw e;
    }

    const [token] = await cf.listBuildTokens(accountId);
    if (!token) {
      throw new PauseError({
        reason:
          "Your Cloudflare account has no Workers Builds token yet. In the dashboard, open any Worker, go to Settings → Builds and connect a repository once – Cloudflare creates the token then. Then select Check again.",
        actionLabel: "Open Workers & Pages",
        actionUrl: `https://dash.cloudflare.com/${accountId}/workers-and-pages`,
      });
    }

    const existing = await cf.listTriggers(accountId, workerTag);
    const exec = (line: string) => execString(plan.packageManager, line);
    const base = {
      external_script_id: workerTag,
      repo_connection_uuid: connection,
      build_token_uuid: token.build_token_uuid,
      root_directory: repo.rootDirectory ? `/${repo.rootDirectory}` : "/",
      path_includes: ["*"],
      path_excludes: [],
      build_caching_enabled: true,
    };
    const ensure = async (input: TriggerInput): Promise<BuildTrigger> =>
      existing.find((t) => t.trigger_name === input.trigger_name) ?? cf.createTrigger(accountId, input);

    const production = await ensure({
      ...base,
      trigger_name: PRODUCTION_TRIGGER,
      build_command: exec("cf build"),
      deploy_command: exec("cf deploy --prebuilt"),
      branch_includes: [repo.productionBranch],
      branch_excludes: [],
    });
    const preview = await ensure({
      ...base,
      trigger_name: PREVIEW_TRIGGER,
      build_command: exec("cf build"),
      deploy_command: PREVIEW_DEPLOY_COMMAND,
      branch_includes: ["*"],
      branch_excludes: [repo.productionBranch],
    });

    for (const [trigger, which] of [
      [production, "production"],
      [preview, "preview"],
    ] as const) {
      const vars = triggerVariables(plan.env, ctx.values, which);
      if (Object.keys(vars).length) await cf.setTriggerEnv(accountId, trigger.trigger_uuid, vars);
      ctx.log(`${trigger.trigger_name}: ${Object.keys(vars).length} build variables set`);
    }
    ctx.outputs.productionTrigger = production.trigger_uuid;
    ctx.outputs.previewTrigger = preview.trigger_uuid;
  },
};

export const startBuildStep: Step = {
  id: "start-build",
  title: "Run the first Cloudflare build",
  async run(ctx) {
    const { plan, accountId } = ctx.job;
    const cf = ctx.deps.cloudflare;
    const trigger = requireOutput(ctx, "builds", "previewTrigger");
    const buildUuid = await cf.startBuild(accountId, trigger, MIGRATION_BRANCH);
    const url = buildDashboardUrl(accountId, plan.workerName, buildUuid);
    ctx.outputs.buildUuid = buildUuid;
    ctx.outputs.buildUrl = url;
    ctx.log(`Started build ${buildUuid}: ${url}`);

    const deadline = ctx.deps.now() + BUILD_TIMEOUT_MS;
    let last = "";
    for (;;) {
      const build = await cf.getBuild(accountId, buildUuid);
      const label = build.build_outcome ? `${build.status} (${build.build_outcome})` : build.status;
      if (label !== last) {
        ctx.log(`Build status: ${label}`);
        last = label;
      }
      const state = interpretBuild(build);
      if (state === "success") return;
      if (state === "failure") {
        throw new Error(`The Cloudflare build finished with "${build.build_outcome ?? build.status}". Open the build log: ${url}`);
      }
      if (ctx.deps.now() > deadline) {
        throw new Error(`The Cloudflare build is still running after 30 minutes. Check it in the dashboard: ${url}`);
      }
      await ctx.deps.sleep(POLL_MS);
    }
  },
};
```

`src/pipeline/steps/index.ts`:

```ts
import type { Step } from "../types.ts";
import { buildsStep, startBuildStep } from "./builds.ts";
import { deployStep, prStep, pushStep } from "./release.ts";
import { buildStep, cloneStep, convertStep } from "./repo.ts";

export const STEPS: readonly Step[] = [
  cloneStep,
  convertStep,
  buildStep,
  deployStep,
  pushStep,
  prStep,
  buildsStep,
  startBuildStep,
];
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/pipeline && pnpm typecheck`
Expected: all the pipeline tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/steps tests/pipeline/steps/builds.test.ts
git commit -m "feat: connect Workers Builds triggers and watch the first build"
```

---

### Task 21: Client factory, input errors and the job service

**Files:**
- Create: `src/clients/factory.ts`, `src/errors.ts`, `src/pipeline/service.ts`
- Test: `tests/pipeline/service.test.ts`

**Interfaces:**
- Consumes: the clients (Tasks 8–10), `resolveGitHubAuth` and `GitHubAuth` (Task 7), `CredentialStore` (Task 3), `buildPlan`, `PlanDeps` and `MigrationPlan` (Task 16), `JobStore`, `JobEvents`, `JobQueue`, `resetForRetry`, `Job` and `JobEvent` (Task 17), `skipEntries`, `missingInputs` and `EnvValues` (Task 11), and `NextCachePreset` (Task 15).
- Produces:
  - `interface ClientFactory { vercel(): Promise<VercelClient>; cloudflare: CloudflareClient; github(): Promise<GitHubClient>; githubAuth(): Promise<GitHubAuth> }` and `createClientFactory(o: { store; fetch; run; cloudflareToken }): ClientFactory`
  - `class UserInputError extends Error { status: 400 | 404 | 409 }`
  - `interface StartInput { projectId: string; workerName: string; nextCache: NextCachePreset; values: Record<string, string>; skip: string[] }`
  - `interface JobService { plan(projectId): Promise<MigrationPlan>; start(input: StartInput): Promise<Job>; list(): Promise<Job[]>; get(id): Promise<Job | null>; retry(id): Promise<Job>; log(id): Promise<string>; subscribe(id, fn: (e: JobEvent) => void): () => void }`
  - `createJobService(d: { store: JobStore; events: JobEvents; queue: JobQueue; clients: ClientFactory; credentials: CredentialStore; buildPlan?: typeof buildPlan }): JobService`

- [ ] **Step 1: Write the failing tests**

`tests/pipeline/service.test.ts`:

```ts
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCredentialStore } from "../../src/auth/store.ts";
import type { ClientFactory } from "../../src/clients/factory.ts";
import { UserInputError } from "../../src/errors.ts";
import { createJobEvents } from "../../src/pipeline/events.ts";
import { createJobStore } from "../../src/pipeline/job-store.ts";
import type { MigrationPlan, PlanDeps } from "../../src/pipeline/plan.ts";
import { createJobService } from "../../src/pipeline/service.ts";
import { buildEnvPlan } from "../../src/translate/env-plan.ts";
import { samplePlan } from "../helpers/sample-plan.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const { plan: env, values } = buildEnvPlan(
  [
    { id: "a", key: "API_KEY", value: "fetched", type: "encrypted", target: ["production"] },
    { id: "s", key: "SENSITIVE", type: "sensitive", target: ["production"] },
    { id: "t", key: "OTHER_SENSITIVE", type: "sensitive", target: ["production"] },
  ],
  [],
);
const plan: MigrationPlan = { ...samplePlan, env };

async function setup(opts: { accountId?: string; plan?: MigrationPlan } = {}) {
  const dir = await makeTempDir();
  const credentials = createCredentialStore(join(dir, "c.json"));
  if (opts.accountId) {
    await credentials.update(() => ({ cloudflare: { accessToken: "x", expiresAt: 0, accountId: opts.accountId } }));
  }
  const store = createJobStore(join(dir, "jobs"));
  const queue = { enqueue: vi.fn(), idle: async () => {} };
  const buildPlan = vi.fn(async (_d: PlanDeps, _projectId: string) => ({ plan: opts.plan ?? plan, values }));
  const clients = { vercel: async () => ({}), github: async () => ({}), cloudflare: {} } as unknown as ClientFactory;
  const service = createJobService({ store, events: createJobEvents(), queue, clients, credentials, buildPlan });
  return { service, store, queue, buildPlan };
}

const input = { projectId: "prj_1", workerName: "shop", nextCache: "kv" as const, values: {}, skip: [] };

describe("createJobService", () => {
  it("asks for a Cloudflare account before planning", async () => {
    const { service } = await setup();
    await expect(service.plan("prj_1")).rejects.toThrow("Choose a Cloudflare account");
  });

  it("builds a plan for the chosen account", async () => {
    const { service, buildPlan } = await setup({ accountId: "acc" });
    expect(await service.plan("prj_1")).toBe(plan);
    expect(buildPlan.mock.calls[0]?.[0]).toMatchObject({ accountId: "acc" });
  });

  it("refuses to start without a plan, with blockers, or with missing values", async () => {
    const { service } = await setup({ accountId: "acc" });
    await expect(service.start(input)).rejects.toThrow("Build the plan");
    await service.plan("prj_1");
    await expect(service.start(input)).rejects.toThrow("SENSITIVE, OTHER_SENSITIVE");

    const blocked = await setup({ accountId: "acc", plan: { ...plan, blockers: ["No repo"] } });
    await blocked.service.plan("prj_1");
    await expect(blocked.service.start(input)).rejects.toThrow("No repo");
  });

  it("rejects invalid Worker names", async () => {
    const { service } = await setup({ accountId: "acc" });
    await service.plan("prj_1");
    await expect(service.start({ ...input, workerName: "Bad Name", skip: ["s", "t"] })).rejects.toBeInstanceOf(UserInputError);
  });

  it("creates and queues a job with typed values and skips, and only accepts values that were missing", async () => {
    const { service, store, queue } = await setup({ accountId: "acc" });
    await service.plan("prj_1");
    const job = await service.start({
      ...input,
      workerName: "my-shop",
      nextCache: "none",
      values: { s: "typed", a: "attempted-override" },
      skip: ["t"],
    });
    expect(job.plan.workerName).toBe("my-shop");
    expect(job.plan.nextCache).toBe("none");
    expect(job.plan.env.entries.find((e) => e.id === "t")?.skipReason).toBe("Skipped by you");
    expect(await store.readValues(job.id)).toEqual({ a: "fetched", s: "typed" });
    expect(queue.enqueue).toHaveBeenCalledWith(job.id);
    await expect(service.start(input)).rejects.toThrow("Build the plan");
  });

  it("retries only failed or paused jobs", async () => {
    const { service, store, queue } = await setup({ accountId: "acc" });
    const job = await store.create(plan, "acc", {});
    await expect(service.retry(job.id)).rejects.toThrow("Only failed or paused");
    job.status = "failed";
    job.steps[0]!.status = "failed";
    await store.save(job);
    const retried = await service.retry(job.id);
    expect(retried.status).toBe("queued");
    expect(queue.enqueue).toHaveBeenCalledWith(job.id);
    await expect(service.retry("00000000-0000-4000-8000-00000000ffff")).rejects.toMatchObject({ status: 404 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/pipeline/service.test.ts`
Expected: FAIL, because the modules can't be resolved.

- [ ] **Step 3: Implement the modules**

`src/errors.ts`:

```ts
// An error caused by what the user asked for, shown to them as-is.
export class UserInputError extends Error {
  readonly status: 400 | 404 | 409;

  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = "UserInputError";
    this.status = status;
  }
}
```

`src/clients/factory.ts`:

```ts
import { resolveGitHubAuth, type GitHubAuth } from "../auth/github.ts";
import type { CredentialStore } from "../auth/store.ts";
import type { CommandRunner } from "../exec.ts";
import { ApiError, type FetchFn } from "../http.ts";
import { createCloudflareClient, type CloudflareClient } from "./cloudflare.ts";
import { createGitHubClient, type GitHubClient } from "./github.ts";
import { createVercelClient, type VercelClient } from "./vercel.ts";

export interface ClientFactory {
  vercel(): Promise<VercelClient>;
  cloudflare: CloudflareClient;
  github(): Promise<GitHubClient>;
  githubAuth(): Promise<GitHubAuth>;
}

// Clients are built per call from the stored credentials, so reconnecting an
// account takes effect immediately, including for paused jobs.
export function createClientFactory(o: {
  store: CredentialStore;
  fetch: FetchFn;
  run: CommandRunner;
  cloudflareToken: () => Promise<string>;
}): ClientFactory {
  const githubAuth = async () => {
    const auth = await resolveGitHubAuth(o.run, o.store);
    if (!auth) throw new ApiError("github", 401, "GitHub is not connected. Run gh auth login, or paste a token.", true);
    return auth;
  };
  return {
    async vercel() {
      const { vercel } = await o.store.read();
      if (!vercel) throw new ApiError("vercel", 401, "Vercel is not connected", true);
      return createVercelClient({ fetch: o.fetch, token: vercel.token, teamId: vercel.teamId });
    },
    cloudflare: createCloudflareClient({ fetch: o.fetch, token: o.cloudflareToken }),
    async github() {
      const auth = await githubAuth();
      return createGitHubClient({ fetch: o.fetch, token: async () => auth.token });
    },
    githubAuth,
  };
}
```

`src/pipeline/service.ts`:

```ts
import type { NextCachePreset } from "../adapters/types.ts";
import type { CredentialStore } from "../auth/store.ts";
import type { ClientFactory } from "../clients/factory.ts";
import { UserInputError } from "../errors.ts";
import { missingInputs, skipEntries, type EnvValues } from "../translate/env-plan.ts";
import type { JobEvents } from "./events.ts";
import type { JobStore } from "./job-store.ts";
import { buildPlan as defaultBuildPlan, type MigrationPlan } from "./plan.ts";
import type { JobQueue } from "./queue.ts";
import { resetForRetry } from "./runner.ts";
import type { Job, JobEvent } from "./types.ts";

export interface StartInput {
  projectId: string;
  workerName: string;
  nextCache: NextCachePreset;
  values: Record<string, string>;
  skip: string[];
}

export interface JobService {
  plan(projectId: string): Promise<MigrationPlan>;
  start(input: StartInput): Promise<Job>;
  list(): Promise<Job[]>;
  get(id: string): Promise<Job | null>;
  retry(id: string): Promise<Job>;
  log(id: string): Promise<string>;
  subscribe(id: string, fn: (e: JobEvent) => void): () => void;
}

const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function createJobService(d: {
  store: JobStore;
  events: JobEvents;
  queue: JobQueue;
  clients: ClientFactory;
  credentials: CredentialStore;
  buildPlan?: typeof defaultBuildPlan;
}): JobService {
  const buildPlan = d.buildPlan ?? defaultBuildPlan;
  // Plans waiting for approval, with their fetched values, held in memory only.
  const drafts = new Map<string, { plan: MigrationPlan; values: EnvValues; accountId: string }>();

  async function accountId(): Promise<string> {
    const id = (await d.credentials.read()).cloudflare?.accountId;
    if (!id) throw new UserInputError("Choose a Cloudflare account on the Connect page first.");
    return id;
  }

  return {
    async plan(projectId) {
      const account = await accountId();
      const { plan, values } = await buildPlan(
        { vercel: await d.clients.vercel(), github: await d.clients.github(), cloudflare: d.clients.cloudflare, accountId: account },
        projectId,
      );
      drafts.set(projectId, { plan, values, accountId: account });
      return plan;
    },

    async start(input) {
      const draft = drafts.get(input.projectId);
      if (!draft) throw new UserInputError("Build the plan for this project first.", 409);
      if (draft.plan.blockers.length) throw new UserInputError(draft.plan.blockers.join(" "));
      if (!WORKER_NAME.test(input.workerName)) {
        throw new UserInputError("Worker names use lowercase letters, digits and hyphens, up to 63 characters.");
      }
      const env = skipEntries(draft.plan.env, input.skip);
      // Only accept typed values for entries Vercel didn't supply.
      const typed = Object.fromEntries(
        env.entries.filter((e) => e.needsInput && input.values[e.id]).map((e) => [e.id, input.values[e.id] as string]),
      );
      const values = { ...draft.values, ...typed };
      const missing = missingInputs(env, values);
      if (missing.length) {
        throw new UserInputError(`Enter a value, or choose Skip, for: ${missing.map((e) => e.key).join(", ")}.`);
      }
      const plan: MigrationPlan = { ...draft.plan, env, workerName: input.workerName, nextCache: input.nextCache };
      const job = await d.store.create(plan, draft.accountId, values);
      drafts.delete(input.projectId);
      d.queue.enqueue(job.id);
      return job;
    },

    list: () => d.store.list(),
    get: (id) => d.store.get(id),

    async retry(id) {
      const job = await d.store.get(id);
      if (!job) throw new UserInputError("That job doesn't exist.", 404);
      if (job.status !== "failed" && job.status !== "paused") {
        throw new UserInputError("Only failed or paused jobs can be retried.", 409);
      }
      const reset = resetForRetry(job);
      await d.store.save(reset);
      d.queue.enqueue(id);
      return reset;
    },

    log: (id) => d.store.readLog(id),
    subscribe: (id, fn) => d.events.subscribe(id, fn),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/pipeline/service.test.ts && pnpm typecheck`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts src/clients/factory.ts src/pipeline/service.ts tests/pipeline/service.test.ts
git commit -m "feat: add job service for planning, approving and retrying migrations"
```

---

### Task 22: Server app, guards, project and job routes with SSE

**Files:**
- Create: `src/server/guard.ts`, `src/server/app.ts`, `src/server/routes/jobs.ts`
- Test: `tests/server/helpers.ts`, `tests/server/app.test.ts`, `tests/server/jobs.test.ts`

**Interfaces:**
- Consumes: `CredentialStore` (Task 3), `FetchFn` and `ApiError` (Task 2), `PendingAuthStore` (Task 4), `ClientFactory`, `UserInputError`, `JobService` and `StartInput` (Task 21), and `supportForFramework` and `Support` (Task 15).
- Produces:
  - `hostGuard(port: number): MiddlewareHandler` and `tokenGuard(token: string): MiddlewareHandler`
  - `interface AppDeps { port: number; launchToken: string; staticDir: string | null; store: CredentialStore; fetch: FetchFn; clients: ClientFactory; jobs: JobService; oauth: { clientId: string; redirectUri: string; scopes: readonly string[]; pending: PendingAuthStore } }`
  - `createApp(d: AppDeps): Hono`
  - `interface ProjectSummary { id: string; name: string; framework: string | null; repo: string | null; productionBranch: string | null; support: Support }`
  - `jobRoutes(d: AppDeps): Hono`
  - the test helper `makeApp(over?)`

- [ ] **Step 1: Write the server test helper**

`tests/server/helpers.ts`:

```ts
import { join } from "node:path";
import { createPendingAuthStore } from "../../src/auth/cloudflare-oauth.ts";
import { createCredentialStore } from "../../src/auth/store.ts";
import type { ClientFactory } from "../../src/clients/factory.ts";
import type { JobService } from "../../src/pipeline/service.ts";
import { createApp, type AppDeps } from "../../src/server/app.ts";
import { fakeFetch } from "../helpers/fake-fetch.ts";
import { makeTempDir } from "../helpers/tmp.ts";

export const TOKEN = "launch-token-123";

export async function makeApp(over: Partial<AppDeps> = {}) {
  const dir = await makeTempDir();
  const store = createCredentialStore(join(dir, "credentials.json"));
  const deps: AppDeps = {
    port: 4417,
    launchToken: TOKEN,
    staticDir: null,
    store,
    fetch: fakeFetch([]).fetch,
    clients: {} as ClientFactory,
    jobs: {} as JobService,
    oauth: {
      clientId: "cid",
      redirectUri: "http://localhost:4417/auth/cloudflare/callback",
      scopes: ["user-details.read"],
      pending: createPendingAuthStore(),
    },
    ...over,
  };
  const app = createApp(deps);
  const req = (path: string, init: { method?: string; json?: unknown; headers?: Record<string, string> } = {}) =>
    app.request(path, {
      method: init.method ?? "GET",
      headers: {
        host: "localhost:4417",
        "x-switchyard-token": TOKEN,
        ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
  return { app, deps, store, req, dir };
}
```

- [ ] **Step 2: Write the failing tests**

`tests/server/app.test.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JobService } from "../../src/pipeline/service.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { makeApp, TOKEN } from "./helpers.ts";

const jobs = { list: async () => [] } as unknown as JobService;

describe("guards", () => {
  it("rejects unexpected Host headers (DNS rebinding)", async () => {
    const { req } = await makeApp({ jobs });
    const res = await req("/api/jobs", { headers: { host: "evil.example:4417" } });
    expect(res.status).toBe(403);
  });

  it("rejects API calls without the launch token", async () => {
    const { req } = await makeApp({ jobs });
    expect((await req("/api/jobs", { headers: { "x-switchyard-token": "" } })).status).toBe(401);
    expect((await req("/api/jobs", { headers: { "x-switchyard-token": "wrong-token-xyz" } })).status).toBe(401);
  });

  it("accepts the token as a header or a t query parameter, and 127.0.0.1 as host", async () => {
    const { req } = await makeApp({ jobs });
    expect((await req("/api/jobs")).status).toBe(200);
    expect(
      (await req(`/api/jobs?t=${TOKEN}`, { headers: { "x-switchyard-token": "", host: "127.0.0.1:4417" } })).status,
    ).toBe(200);
  });
});

describe("static files", () => {
  it("serves the SPA without a token, and falls back to index.html", async () => {
    const staticDir = await makeTempDir();
    await mkdir(join(staticDir, "assets"), { recursive: true });
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Switchyard</title>");
    await writeFile(join(staticDir, "assets", "app.js"), "console.log(1)");
    const { req } = await makeApp({ jobs, staticDir });
    const headers = { "x-switchyard-token": "" };
    expect(await (await req("/", { headers })).text()).toContain("<title>Switchyard</title>");
    expect(await (await req("/assets/app.js", { headers })).text()).toBe("console.log(1)");
    expect(await (await req("/projects", { headers })).text()).toContain("<title>Switchyard</title>");
  });
});
```

`tests/server/jobs.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { ClientFactory } from "../../src/clients/factory.ts";
import type { VercelClient } from "../../src/clients/vercel.ts";
import { UserInputError } from "../../src/errors.ts";
import { ApiError } from "../../src/http.ts";
import type { JobService } from "../../src/pipeline/service.ts";
import type { Job, JobEvent } from "../../src/pipeline/types.ts";
import { samplePlan } from "../helpers/sample-plan.ts";
import { makeApp } from "./helpers.ts";

const job = { id: "00000000-0000-4000-8000-000000000001", status: "queued", plan: samplePlan, steps: [] } as unknown as Job;

describe("project routes", () => {
  it("lists Vercel projects with repo and support level", async () => {
    const vercel = {
      listProjects: async () => [
        { id: "p1", name: "shop", framework: "nextjs", rootDirectory: null, link: { type: "github", org: "acme", repo: "shop", productionBranch: "main" } },
        { id: "p2", name: "blog", framework: "astro", rootDirectory: null },
      ],
    } as unknown as VercelClient;
    const { req } = await makeApp({ clients: { vercel: async () => vercel } as unknown as ClientFactory });
    expect(await (await req("/api/projects")).json()).toEqual([
      { id: "p1", name: "shop", framework: "nextjs", repo: "acme/shop", productionBranch: "main", support: { level: "supported" } },
      { id: "p2", name: "blog", framework: "astro", repo: null, productionBranch: null, support: { level: "unsupported", reason: "astro projects aren't supported yet" } },
    ]);
  });

  it("asks the client to reconnect on auth errors", async () => {
    const clients = {
      vercel: async () => {
        throw new ApiError("vercel", 401, "Vercel is not connected", true);
      },
    } as unknown as ClientFactory;
    const { req } = await makeApp({ clients });
    const res = await req("/api/projects");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "vercel API error 401: Vercel is not connected", reconnect: "vercel" });
  });

  it("builds a plan", async () => {
    const jobs = { plan: vi.fn(async () => samplePlan) } as unknown as JobService;
    const { req } = await makeApp({ jobs });
    const res = await req("/api/projects/p1/plan", { method: "POST" });
    expect(await res.json()).toEqual(samplePlan);
    expect(jobs.plan).toHaveBeenCalledWith("p1");
  });
});

describe("job routes", () => {
  it("validates and starts a job", async () => {
    const start = vi.fn(async () => job);
    const { req } = await makeApp({ jobs: { start } as unknown as JobService });
    expect((await req("/api/jobs", { method: "POST", json: { projectId: "p1" } })).status).toBe(400);
    const res = await req("/api/jobs", {
      method: "POST",
      json: { projectId: "p1", workerName: "shop", nextCache: "kv", values: { s: "v" }, skip: [] },
    });
    expect(res.status).toBe(201);
    expect(start).toHaveBeenCalledWith({ projectId: "p1", workerName: "shop", nextCache: "kv", values: { s: "v" }, skip: [] });
  });

  it("returns user input errors with their status", async () => {
    const jobs = {
      start: async () => {
        throw new UserInputError("Enter a value for: X.");
      },
      get: async () => null,
    } as unknown as JobService;
    const { req } = await makeApp({ jobs });
    const res = await req("/api/jobs", {
      method: "POST",
      json: { projectId: "p1", workerName: "shop", nextCache: "kv", values: {}, skip: [] },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Enter a value for: X." });
    expect((await req(`/api/jobs/${job.id}`)).status).toBe(404);
  });

  it("retries and returns the log", async () => {
    const jobs = { retry: vi.fn(async () => job), log: async () => "[clone] ok\n" } as unknown as JobService;
    const { req } = await makeApp({ jobs });
    expect((await req(`/api/jobs/${job.id}/retry`, { method: "POST" })).status).toBe(200);
    expect(await (await req(`/api/jobs/${job.id}/log`)).text()).toBe("[clone] ok\n");
  });

  it("streams the current job, then events, over SSE", async () => {
    let listener: ((e: JobEvent) => void) | undefined;
    const jobs = {
      get: async () => job,
      subscribe: (_id: string, fn: (e: JobEvent) => void) => {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
    } as unknown as JobService;
    const { req } = await makeApp({ jobs });
    const res = await req(`/api/jobs/${job.id}/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain("event: job");
    await vi.waitFor(() => expect(listener).toBeDefined());
    listener?.({ type: "log", jobId: job.id, step: "clone", line: "hello" });
    const second = decoder.decode((await reader.read()).value);
    expect(second).toContain("event: log");
    expect(second).toContain('"line":"hello"');
    await reader.cancel();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test tests/server`
Expected: FAIL, because the modules can't be resolved.

- [ ] **Step 4: Implement the server**

`src/server/guard.ts`:

```ts
import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

// Blocks DNS rebinding: a page on another domain that resolves to 127.0.0.1
// still sends its own hostname in the Host header.
export function hostGuard(port: number): MiddlewareHandler {
  const allowed = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  return async (c, next) => {
    if (!allowed.has(c.req.header("host") ?? "")) return c.text("Forbidden: unexpected Host header", 403);
    await next();
  };
}

// Stops other pages in the browser from calling the API: only the tab opened
// from the terminal link knows the per-launch token.
export function tokenGuard(token: string): MiddlewareHandler {
  const expected = Buffer.from(token);
  return async (c, next) => {
    const given = Buffer.from(c.req.header("x-switchyard-token") || c.req.query("t") || "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return c.json({ error: "Missing or wrong launch token. Open Switchyard from the link printed in the terminal." }, 401);
    }
    await next();
  };
}
```

`src/server/app.ts`:

```ts
import { relative } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import type { PendingAuthStore } from "../auth/cloudflare-oauth.ts";
import type { CredentialStore } from "../auth/store.ts";
import type { ClientFactory } from "../clients/factory.ts";
import { UserInputError } from "../errors.ts";
import { ApiError, type FetchFn } from "../http.ts";
import type { JobService } from "../pipeline/service.ts";
import { hostGuard, tokenGuard } from "./guard.ts";
import { jobRoutes } from "./routes/jobs.ts";

export interface AppDeps {
  port: number;
  launchToken: string;
  staticDir: string | null;
  store: CredentialStore;
  fetch: FetchFn;
  clients: ClientFactory;
  jobs: JobService;
  oauth: { clientId: string; redirectUri: string; scopes: readonly string[]; pending: PendingAuthStore };
}

export function createApp(d: AppDeps): Hono {
  const app = new Hono();
  app.use("*", hostGuard(d.port));
  app.use("/api/*", tokenGuard(d.launchToken));
  app.route("/api", jobRoutes(d));

  if (d.staticDir) {
    const root = relative(process.cwd(), d.staticDir) || ".";
    app.use("/*", serveStatic({ root }));
    app.get("*", serveStatic({ root, path: "index.html" }));
  }

  app.onError((err, c) => {
    if (err instanceof UserInputError) return c.json({ error: err.message }, err.status);
    if (err instanceof ZodError) {
      return c.json({ error: `Invalid request: ${err.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` }, 400);
    }
    if (err instanceof ApiError) {
      return err.auth ? c.json({ error: err.message, reconnect: err.service }, 401) : c.json({ error: err.message }, 502);
    }
    if (err instanceof HTTPException) return err.getResponse();
    console.error(err);
    return c.json({ error: err.message }, 500);
  });
  return app;
}
```

`src/server/routes/jobs.ts`:

```ts
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { supportForFramework } from "../../adapters/registry.ts";
import type { Support } from "../../adapters/types.ts";
import type { AppDeps } from "../app.ts";

export interface ProjectSummary {
  id: string;
  name: string;
  framework: string | null;
  repo: string | null;
  productionBranch: string | null;
  support: Support;
}

const startSchema = z.object({
  projectId: z.string().min(1),
  workerName: z.string().min(1),
  nextCache: z.enum(["kv", "none"]),
  values: z.record(z.string(), z.string()),
  skip: z.array(z.string()),
});

export function jobRoutes(d: AppDeps): Hono {
  const r = new Hono();

  r.get("/projects", async (c) => {
    const projects = await (await d.clients.vercel()).listProjects();
    return c.json(
      projects.map(
        (p): ProjectSummary => ({
          id: p.id,
          name: p.name,
          framework: p.framework,
          repo: p.link?.org && p.link.repo ? `${p.link.org}/${p.link.repo}` : null,
          productionBranch: p.link?.productionBranch ?? null,
          support: supportForFramework(p.framework),
        }),
      ),
    );
  });

  r.post("/projects/:id/plan", async (c) => c.json(await d.jobs.plan(c.req.param("id"))));

  r.post("/jobs", async (c) => c.json(await d.jobs.start(startSchema.parse(await c.req.json())), 201));
  r.get("/jobs", async (c) => c.json(await d.jobs.list()));
  r.get("/jobs/:id", async (c) => {
    const job = await d.jobs.get(c.req.param("id"));
    return job ? c.json(job) : c.json({ error: "That job doesn't exist." }, 404);
  });
  r.post("/jobs/:id/retry", async (c) => c.json(await d.jobs.retry(c.req.param("id"))));
  r.get("/jobs/:id/log", async (c) => c.text(await d.jobs.log(c.req.param("id"))));

  r.get("/jobs/:id/events", (c) => {
    const id = c.req.param("id");
    return streamSSE(c, async (stream) => {
      const job = await d.jobs.get(id);
      if (!job) {
        await stream.writeSSE({ event: "error", data: "That job doesn't exist." });
        return;
      }
      await stream.writeSSE({ event: "job", data: JSON.stringify(job) });
      const unsubscribe = d.jobs.subscribe(id, (e) => {
        void stream.writeSSE(
          e.type === "job"
            ? { event: "job", data: JSON.stringify(e.job) }
            : { event: "log", data: JSON.stringify({ step: e.step, line: e.line }) },
        );
      });
      stream.onAbort(unsubscribe);
      while (!stream.aborted && !stream.closed) {
        await stream.sleep(15_000);
        await stream.writeSSE({ event: "ping", data: "" });
      }
      unsubscribe();
    });
  });

  return r;
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test tests/server && pnpm typecheck`
Expected: all the server tests pass.

If the SSE test hangs, the stream isn't noticing the cancelled reader. Check that `stream.onAbort` fires on `reader.cancel()` in this Hono version, and bound the test with `{ timeout: 5000 }` so it fails rather than hangs.

- [ ] **Step 6: Commit**

```bash
git add src/server tests/server
git commit -m "feat: add local server with host and token guards, job routes and SSE"
```

---

### Task 23: Connect routes (status, Vercel, GitHub, Cloudflare OAuth)

**Files:**
- Create: `src/server/routes/connect.ts`
- Modify: `src/server/app.ts` (mount the routes)
- Test: `tests/server/connect.test.ts`

**Interfaces:**
- Consumes: `AppDeps` (Task 22), `createVercelClient` and `probeVercelToken` (Task 8), `inferTokenScope` (Task 13), `createGitHubClient` (Task 10), `createCloudflareClient` (Task 9), `buildAuthorizeUrl` and `exchangeCode` (Task 4), `tokenGuard` (Task 22) and `isAuthError` (Task 2).
- Produces:
  - `type ConnectionStatus = { vercel: …; cloudflare: …; github: … }` (exact shape below)
  - `connectRoutes(d: AppDeps): Hono`, which serves:
    - `GET /api/status`
    - `POST /api/vercel/token`, `POST /api/vercel/team` and `DELETE /api/vercel`
    - `POST /api/github/pat` and `DELETE /api/github`
    - `GET /auth/cloudflare/start` and `GET /auth/cloudflare/callback`
    - `POST /api/cloudflare/account` and `DELETE /api/cloudflare`

- [ ] **Step 1: Write the failing tests**

`tests/server/connect.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ClientFactory } from "../../src/clients/factory.ts";
import { ApiError } from "../../src/http.ts";
import { fakeFetch, json } from "../helpers/fake-fetch.ts";
import { makeApp, TOKEN } from "./helpers.ts";

const cfOk = (result: unknown) => json({ success: true, errors: [], result, result_info: { page: 1, total_pages: 1 } });

describe("Vercel token", () => {
  it("stores a team-scoped token and warns about an unusual prefix", async () => {
    const f = fakeFetch([
      json({ error: { message: "forbidden" } }, 403),
      json({ error: { message: "forbidden" } }, 403),
      json({ projects: [], pagination: { next: null } }),
    ]);
    const { req, store } = await makeApp({ fetch: f.fetch });
    const res = await req("/api/vercel/token", { method: "POST", json: { token: "  old-style-token  " } });
    const body = (await res.json()) as { scope: string; warning?: string };
    expect(res.status).toBe(200);
    expect(body.scope).toBe("team");
    expect(body.warning).toContain("vcp_");
    expect((await store.read()).vercel).toEqual({ token: "old-style-token", scope: "team" });
  });

  it("rejects a token Vercel refuses, without storing it", async () => {
    const bad = json({ error: { invalidToken: true, message: "Not authorized" } }, 403);
    const { req, store } = await makeApp({ fetch: fakeFetch([bad, bad.clone(), bad.clone()]).fetch });
    const res = await req("/api/vercel/token", { method: "POST", json: { token: "vcp_bad" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("Vercel rejected this token");
    expect((await store.read()).vercel).toBeUndefined();
  });

  it("explains a project-scoped token", async () => {
    const forbidden = json({ error: { message: "forbidden" } }, 403);
    const { req } = await makeApp({ fetch: fakeFetch([forbidden, forbidden.clone(), forbidden.clone()]).fetch });
    const res = await req("/api/vercel/token", { method: "POST", json: { token: "vcp_project" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("All Projects");
  });

  it("only accepts teams the token can see", async () => {
    const vercel = { listTeams: async () => [{ id: "team_1", slug: "acme", name: "Acme" }] };
    const { req, store } = await makeApp({ clients: { vercel: async () => vercel } as unknown as ClientFactory });
    await store.update(() => ({ vercel: { token: "vcp_x", scope: "account" } }));
    expect((await req("/api/vercel/team", { method: "POST", json: { teamId: "team_2" } })).status).toBe(400);
    expect((await req("/api/vercel/team", { method: "POST", json: { teamId: "team_1" } })).status).toBe(200);
    expect((await store.read()).vercel).toMatchObject({ teamId: "team_1", teamName: "Acme" });
  });
});

describe("Cloudflare OAuth", () => {
  it("requires the launch token to start, then redirects with PKCE", async () => {
    const { req } = await makeApp();
    expect((await req("/auth/cloudflare/start", { headers: { "x-switchyard-token": "" } })).status).toBe(401);
    const res = await req(`/auth/cloudflare/start?t=${TOKEN}`, { headers: { "x-switchyard-token": "" } });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin).toBe("https://dash.cloudflare.com");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("state")).toBeTruthy();
  });

  it("rejects a callback with an unknown state", async () => {
    const { req } = await makeApp();
    const res = await req("/auth/cloudflare/callback?code=c&state=nope", { headers: { "x-switchyard-token": "" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("#/connect?error=");
  });

  it("exchanges the code, stores tokens and picks the only account", async () => {
    const f = fakeFetch([
      json({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
      cfOk({ id: "u", email: "me@example.com" }),
      cfOk([{ id: "acc1", name: "Main" }]),
    ]);
    const { req, store, deps } = await makeApp({ fetch: f.fetch });
    const { state } = deps.oauth.pending.create();
    const res = await req(`/auth/cloudflare/callback?code=abc&state=${state}`, { headers: { "x-switchyard-token": "" } });
    expect(res.headers.get("location")).toBe(`/?t=${TOKEN}#/connect`);
    expect((await store.read()).cloudflare).toMatchObject({
      accessToken: "at",
      refreshToken: "rt",
      email: "me@example.com",
      accountId: "acc1",
      accountName: "Main",
    });
  });

  it("reports an OAuth error returned by Cloudflare", async () => {
    const { req } = await makeApp();
    const res = await req("/auth/cloudflare/callback?error=access_denied&error_description=User%20said%20no", {
      headers: { "x-switchyard-token": "" },
    });
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("User said no");
  });
});

describe("GitHub", () => {
  it("validates and stores a PAT", async () => {
    const f = fakeFetch([json({ login: "matt" })]);
    const { req, store } = await makeApp({ fetch: f.fetch });
    const res = await req("/api/github/pat", { method: "POST", json: { token: "github_pat_x" } });
    expect(await res.json()).toEqual({ ok: true, login: "matt" });
    expect((await store.read()).githubPat).toBe("github_pat_x");
  });
});

describe("status", () => {
  it("reports each service, treating auth failures as disconnected", async () => {
    const clients = {
      vercel: async () => ({ listTeams: async () => [] }),
      cloudflare: {
        listAccounts: async () => {
          throw new ApiError("cloudflare", 401, "expired", true);
        },
      },
      githubAuth: async () => ({ token: "gho", source: "gh" }),
      github: async () => ({ getViewer: async () => ({ login: "matt" }) }),
    } as unknown as ClientFactory;
    const { req, store } = await makeApp({ clients });
    await store.update(() => ({
      vercel: { token: "vcp", scope: "team", username: "matt" },
      cloudflare: { accessToken: "x", expiresAt: 0 },
    }));
    expect(await (await req("/api/status")).json()).toEqual({
      vercel: { connected: true, scope: "team", username: "matt", teams: [] },
      cloudflare: { connected: false, error: "cloudflare API error 401: expired" },
      github: { connected: true, source: "gh", login: "matt" },
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/server/connect.test.ts`
Expected: FAIL, because `connect.ts` doesn't exist yet.

- [ ] **Step 3: Implement the routes**

`src/server/routes/connect.ts`:

```ts
import { Hono } from "hono";
import { z } from "zod";
import { buildAuthorizeUrl, exchangeCode } from "../../auth/cloudflare-oauth.ts";
import { createCloudflareClient, type CloudflareAccount } from "../../clients/cloudflare.ts";
import { createGitHubClient } from "../../clients/github.ts";
import { createVercelClient, probeVercelToken, type ScopeProbe, type VercelTeam } from "../../clients/vercel.ts";
import { UserInputError } from "../../errors.ts";
import { isAuthError } from "../../http.ts";
import { inferTokenScope } from "../../translate/token-scope.ts";
import type { AppDeps } from "../app.ts";
import { tokenGuard } from "../guard.ts";

export interface ConnectionStatus {
  vercel:
    | { connected: false }
    | { connected: true; scope: "account" | "team"; username?: string; teamId?: string; teamName?: string; teams: VercelTeam[] };
  cloudflare:
    | { connected: false; error?: string }
    | { connected: true; email?: string; accountId?: string; accountName?: string; accounts: CloudflareAccount[] };
  github: { connected: false; error?: string } | { connected: true; source: "gh" | "pat"; login: string };
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function connectRoutes(d: AppDeps): Hono {
  const r = new Hono();

  r.get("/api/status", async (c) => {
    const creds = await d.store.read();

    const vercel = async (): Promise<ConnectionStatus["vercel"]> => {
      if (!creds.vercel) return { connected: false };
      const { token: _token, ...rest } = creds.vercel;
      const teams = rest.scope === "account" ? await (await d.clients.vercel()).listTeams().catch(() => []) : [];
      return { connected: true, ...rest, teams };
    };
    const cloudflare = async (): Promise<ConnectionStatus["cloudflare"]> => {
      if (!creds.cloudflare) return { connected: false };
      try {
        const accounts = await d.clients.cloudflare.listAccounts();
        const { email, accountId, accountName } = creds.cloudflare;
        return { connected: true, email, accountId, accountName, accounts };
      } catch (e) {
        if (isAuthError(e)) return { connected: false, error: e.message };
        throw e;
      }
    };
    const github = async (): Promise<ConnectionStatus["github"]> => {
      try {
        const auth = await d.clients.githubAuth();
        const { login } = await (await d.clients.github()).getViewer();
        return { connected: true, source: auth.source, login };
      } catch (e) {
        return { connected: false, error: errorText(e) };
      }
    };

    const [v, cf, gh] = await Promise.all([vercel(), cloudflare(), github()]);
    // JSON drops undefined fields, so the browser sees only what is known.
    return c.json({ vercel: v, cloudflare: cf, github: gh } satisfies ConnectionStatus);
  });

  r.post("/api/vercel/token", async (c) => {
    const { token } = z.object({ token: z.string().trim().min(1) }).parse(await c.req.json());
    let probe: ScopeProbe;
    try {
      probe = await probeVercelToken(createVercelClient({ fetch: d.fetch, token }));
    } catch (e) {
      if (isAuthError(e)) {
        throw new UserInputError("Vercel rejected this token. Check that you copied all of it and that it hasn't expired.");
      }
      throw e;
    }
    const scope = inferTokenScope(probe);
    if (scope.kind === "limited") {
      throw new UserInputError(
        "This token can't list projects. Create one scoped to a team with All Projects selected, or to Full Account.",
      );
    }
    await d.store.update((cr) => ({
      ...cr,
      vercel: { token, scope: scope.kind, ...(probe.user ? { username: probe.user.username } : {}) },
    }));
    return c.json({
      ok: true,
      scope: scope.kind,
      warning: token.startsWith("vcp_")
        ? undefined
        : "This doesn't look like a current Vercel token (they start with vcp_). It worked, so Switchyard will use it.",
    });
  });

  r.post("/api/vercel/team", async (c) => {
    const { teamId } = z.object({ teamId: z.string().nullable() }).parse(await c.req.json());
    const team = teamId ? (await (await d.clients.vercel()).listTeams()).find((t) => t.id === teamId) : null;
    if (teamId && !team) throw new UserInputError("This token can't see that team.");
    await d.store.update((cr) => {
      if (!cr.vercel) throw new UserInputError("Connect Vercel first.");
      const { teamId: _id, teamName: _name, ...rest } = cr.vercel;
      return { ...cr, vercel: team ? { ...rest, teamId: team.id, teamName: team.name } : rest };
    });
    return c.json({ ok: true });
  });

  r.delete("/api/vercel", async (c) => {
    await d.store.update(({ vercel: _v, ...rest }) => rest);
    return c.json({ ok: true });
  });

  r.post("/api/github/pat", async (c) => {
    const { token } = z.object({ token: z.string().trim().min(1) }).parse(await c.req.json());
    let login: string;
    try {
      ({ login } = await createGitHubClient({ fetch: d.fetch, token: async () => token }).getViewer());
    } catch (e) {
      if (isAuthError(e)) throw new UserInputError("GitHub rejected this token.");
      throw e;
    }
    await d.store.update((cr) => ({ ...cr, githubPat: token }));
    return c.json({ ok: true, login });
  });

  r.delete("/api/github", async (c) => {
    await d.store.update(({ githubPat: _p, ...rest }) => rest);
    return c.json({ ok: true });
  });

  r.get("/auth/cloudflare/start", tokenGuard(d.launchToken), (c) => {
    const { state, challenge } = d.oauth.pending.create();
    return c.redirect(
      buildAuthorizeUrl({
        clientId: d.oauth.clientId,
        redirectUri: d.oauth.redirectUri,
        scopes: d.oauth.scopes,
        state,
        challenge,
      }),
    );
  });

  // Not behind the token guard: Cloudflare redirects here. The state
  // parameter, known only to this server, authenticates the request instead.
  r.get("/auth/cloudflare/callback", async (c) => {
    const back = (error?: string) =>
      c.redirect(`/?t=${encodeURIComponent(d.launchToken)}#/connect${error ? `?error=${encodeURIComponent(error)}` : ""}`);
    const q = c.req.query();
    if (q.error) return back(q.error_description ?? q.error);
    const verifier = d.oauth.pending.take(q.state ?? "");
    if (!verifier || !q.code) return back("The login link expired or was already used. Try again.");
    try {
      const tokens = await exchangeCode(d.fetch, {
        clientId: d.oauth.clientId,
        redirectUri: d.oauth.redirectUri,
        code: q.code,
        verifier,
      });
      const cf = createCloudflareClient({ fetch: d.fetch, token: async () => tokens.accessToken });
      const user = await cf.getUser();
      const accounts = await cf.listAccounts();
      const only = accounts.length === 1 ? accounts[0] : undefined;
      await d.store.update((cr) => ({
        ...cr,
        cloudflare: {
          ...tokens,
          email: user.email,
          ...(only ? { accountId: only.id, accountName: only.name } : {}),
        },
      }));
      return back();
    } catch (e) {
      return back(errorText(e));
    }
  });

  r.post("/api/cloudflare/account", async (c) => {
    const { accountId } = z.object({ accountId: z.string().min(1) }).parse(await c.req.json());
    const account = (await d.clients.cloudflare.listAccounts()).find((a) => a.id === accountId);
    if (!account) throw new UserInputError("You don't have access to that Cloudflare account.");
    await d.store.update((cr) => {
      if (!cr.cloudflare) throw new UserInputError("Log in with Cloudflare first.");
      return { ...cr, cloudflare: { ...cr.cloudflare, accountId: account.id, accountName: account.name } };
    });
    return c.json({ ok: true });
  });

  r.delete("/api/cloudflare", async (c) => {
    await d.store.update(({ cloudflare: _cf, ...rest }) => rest);
    return c.json({ ok: true });
  });

  return r;
}
```

- [ ] **Step 4: Mount the routes in `src/server/app.ts`**

Add the import below the existing `jobRoutes` import:

```ts
import { connectRoutes } from "./routes/connect.ts";
```

Mount it before the job routes, so `/auth/*` and `/api/status` resolve. The block becomes:

```ts
  app.use("/api/*", tokenGuard(d.launchToken));
  app.route("/", connectRoutes(d));
  app.route("/api", jobRoutes(d));
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test tests/server && pnpm typecheck`
Expected: all the server tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/server tests/server/connect.test.ts
git commit -m "feat: add connect routes for Vercel tokens, GitHub and Cloudflare OAuth"
```

---

### Task 24: Server entry point and start-up

**Files:**
- Create: `src/server/listen-error.ts`, `src/server/main.ts`
- Test: `tests/server/listen-error.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `describeListenError(e: NodeJS.ErrnoException, port: number): string`, and a runnable `pnpm start`.

- [ ] **Step 1: Write the failing test**

`tests/server/listen-error.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { describeListenError } from "../../src/server/listen-error.ts";

describe("describeListenError", () => {
  it("explains why port 4417 specifically is needed", () => {
    const msg = describeListenError(Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }), 4417);
    expect(msg).toContain("Port 4417 is already in use");
    expect(msg).toContain("Cloudflare login");
    expect(msg).toContain("lsof -i :4417");
  });

  it("passes other errors through", () => {
    expect(describeListenError(Object.assign(new Error("boom"), { code: "EACCES" }), 4417)).toContain("boom");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/server/listen-error.test.ts`
Expected: FAIL, because the module can't be resolved.

- [ ] **Step 3: Implement the module and the entry point**

`src/server/listen-error.ts`:

```ts
export function describeListenError(e: NodeJS.ErrnoException, port: number): string {
  if (e.code === "EADDRINUSE") {
    return [
      `Port ${port} is already in use, so Switchyard can't start.`,
      `It needs this exact port because the Cloudflare login redirects to http://localhost:${port}.`,
      `Find the other process with: lsof -i :${port}`,
    ].join("\n");
  }
  return `Switchyard couldn't start: ${e.message}`;
}
```

`src/server/main.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import open from "open";
import { adapterById } from "../adapters/registry.ts";
import { createCloudflareTokenProvider, createPendingAuthStore } from "../auth/cloudflare-oauth.ts";
import { randomToken } from "../auth/pkce.ts";
import { createCredentialStore } from "../auth/store.ts";
import { createClientFactory } from "../clients/factory.ts";
import { CLOUDFLARE_CLIENT_ID, CLOUDFLARE_REDIRECT_URI, CLOUDFLARE_SCOPES, ORIGIN, PORT } from "../config.ts";
import { createCommandRunner } from "../exec.ts";
import { resolvePaths } from "../paths.ts";
import { createJobEvents } from "../pipeline/events.ts";
import { createJobStore } from "../pipeline/job-store.ts";
import { createJobQueue } from "../pipeline/queue.ts";
import { runJob } from "../pipeline/runner.ts";
import { createJobService } from "../pipeline/service.ts";
import { STEPS } from "../pipeline/steps/index.ts";
import type { PipelineDeps } from "../pipeline/types.ts";
import { createRedactor } from "../redact.ts";
import { createApp } from "./app.ts";
import { describeListenError } from "./listen-error.ts";

const paths = resolvePaths();
const store = createCredentialStore(paths.credentialsFile);
const run = createCommandRunner();
const redactor = createRedactor();
const cloudflareToken = createCloudflareTokenProvider({ store, fetch, clientId: CLOUDFLARE_CLIENT_ID });
const clients = createClientFactory({ store, fetch, run, cloudflareToken });
const jobStore = createJobStore(paths.jobsDir);
const events = createJobEvents();

const pipeline: PipelineDeps = {
  run,
  cloudflare: clients.cloudflare,
  github: clients.github,
  githubToken: async () => (await clients.githubAuth()).token,
  cloudflareToken,
  adapter: adapterById,
  workDir: paths.workDir,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};
const queue = createJobQueue(
  (id) => runJob(id, STEPS, { store: jobStore, events, redactor, pipeline }),
  (id, e) => console.error(`Job ${id} stopped unexpectedly:`, redactor.redact(String(e))),
);
const jobs = createJobService({ store: jobStore, events, queue, clients, credentials: store });

const { failed, queued } = await jobStore.recoverInterrupted();
if (failed.length) console.log(`${failed.length} job(s) were interrupted last time and can be retried.`);
for (const id of queued) queue.enqueue(id);

const staticDir = join(import.meta.dirname, "..", "..", "dist", "web");
if (!existsSync(join(staticDir, "index.html"))) {
  console.warn("The web UI hasn't been built yet. Run `pnpm build:web` first.");
}

const launchToken = randomToken();
const app = createApp({
  port: PORT,
  launchToken,
  staticDir: existsSync(staticDir) ? staticDir : null,
  store,
  fetch,
  clients,
  jobs,
  oauth: {
    clientId: CLOUDFLARE_CLIENT_ID,
    redirectUri: CLOUDFLARE_REDIRECT_URI,
    scopes: CLOUDFLARE_SCOPES,
    pending: createPendingAuthStore(),
  },
});

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: PORT }, () => {
  const url = `${ORIGIN}/?t=${launchToken}`;
  console.log(`Switchyard is running at ${url}`);
  if (!process.env.SWITCHYARD_NO_OPEN) void open(url);
});
server.on("error", (e) => {
  console.error(describeListenError(e as NodeJS.ErrnoException, PORT));
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
```

- [ ] **Step 4: Run the test and a smoke start**

```bash
pnpm test tests/server/listen-error.test.ts && pnpm typecheck
SWITCHYARD_HOME=$(mktemp -d) SWITCHYARD_NO_OPEN=1 timeout 5 pnpm start; test $? -eq 124 && echo "started and kept running"
```

Expected: the test passes. The start prints `Switchyard is running at http://localhost:4417/?t=…`, warns that the web UI isn't built yet, and keeps running until `timeout` stops it.

Then start a second copy while the first is running:

```bash
SWITCHYARD_HOME=$(mktemp -d) SWITCHYARD_NO_OPEN=1 pnpm start &
sleep 2
SWITCHYARD_HOME=$(mktemp -d) SWITCHYARD_NO_OPEN=1 pnpm start
kill %1
```

Expected: the second copy prints the "Port 4417 is already in use" message and exits 1.

- [ ] **Step 5: Commit**

```bash
git add src/server/listen-error.ts src/server/main.ts tests/server/listen-error.test.ts
git commit -m "feat: wire up the Switchyard server entry point"
```

---

### Task 25: Web foundation and the Connect screen

**Files:**
- Create: `vite.config.ts`, `web/index.html`, `web/src/main.tsx`, `web/src/api.ts`, `web/src/router.ts`, `web/src/styles.css`, `web/src/App.tsx` and `web/src/pages/Connect.tsx`
- Test: `tests/web/router.test.ts`

**Interfaces:**
- Consumes: the `ConnectionStatus` type (Task 23).
- Produces:
  - `api<T>(path, init?: { method?: string; body?: unknown }): Promise<T>`, `apiText(path): Promise<string>`, `class ApiFailure extends Error { reconnect?: string }` and `authUrl(path): string`
  - `interface Route { page: string; id?: string; query: URLSearchParams }`, `parseHash(hash: string): Route`, `useRoute(): Route` and `go(hash: string): void`
  - the `Connect` component

- [ ] **Step 1: Write the failing router test**

`tests/web/router.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseHash } from "../../web/src/router.ts";

describe("parseHash", () => {
  it("defaults to the connect page", () => {
    expect(parseHash("")).toMatchObject({ page: "connect", id: undefined });
    expect(parseHash("#/")).toMatchObject({ page: "connect" });
  });

  it("reads page, id and query", () => {
    const r = parseHash("#/plan/prj_1?next=prj_2,prj_3");
    expect(r.page).toBe("plan");
    expect(r.id).toBe("prj_1");
    expect(r.query.get("next")).toBe("prj_2,prj_3");
  });

  it("reads a query on a page without an id", () => {
    expect(parseHash("#/connect?error=denied").query.get("error")).toBe("denied");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/web/router.test.ts`
Expected: FAIL, because the module can't be resolved.

- [ ] **Step 3: Write the web foundation**

`vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
});
```

`web/index.html`:

```html
<!doctype html>
<html lang="en-GB">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Switchyard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`web/src/api.ts`:

```ts
const KEY = "switchyard-launch-token";

// The launch token arrives once in the URL (?t=…). Keep it for this tab only
// and remove it from the address bar so it isn't copied around by accident.
function readLaunchToken(): string {
  const fromUrl = new URLSearchParams(location.search).get("t");
  if (fromUrl) {
    sessionStorage.setItem(KEY, fromUrl);
    history.replaceState(null, "", location.pathname + location.hash);
    return fromUrl;
  }
  return sessionStorage.getItem(KEY) ?? "";
}

const token = readLaunchToken();

export class ApiFailure extends Error {
  readonly reconnect?: string;

  constructor(message: string, reconnect?: string) {
    super(message);
    this.name = "ApiFailure";
    this.reconnect = reconnect;
  }
}

async function request(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: {
      "x-switchyard-token": token,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; reconnect?: string };
    throw new ApiFailure(data.error ?? `Request failed (${res.status})`, data.reconnect);
  }
  return res;
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const text = await (await request(path, init)).text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function apiText(path: string): Promise<string> {
  return (await request(path)).text();
}

// For links and EventSource, which can't send headers.
export function authUrl(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(token)}`;
}
```

`web/src/router.ts`:

```ts
import { useEffect, useState } from "react";

export interface Route {
  page: string;
  id?: string;
  query: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const [page, id] = path.split("/");
  return { page: page || "connect", id: id || undefined, query: new URLSearchParams(query) };
}

export function useRoute(): Route {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const update = () => setHash(location.hash);
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);
  return parseHash(hash);
}

export function go(hash: string): void {
  location.hash = hash;
}
```

`web/src/styles.css`:

```css
:root {
  --bg: #fafaf9;
  --fg: #1c1917;
  --muted: #57534e;
  --card: #ffffff;
  --border: #e7e5e4;
  --accent: #c2410c;
  --ok: #15803d;
  --warn: #a16207;
  --err: #b91c1c;
  font-family: system-ui, sans-serif;
  color: var(--fg);
  background: var(--bg);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1c1917;
    --fg: #f5f5f4;
    --muted: #a8a29e;
    --card: #292524;
    --border: #44403c;
    --accent: #fb923c;
    --ok: #4ade80;
    --warn: #facc15;
    --err: #f87171;
  }
}
body { margin: 0; }
header { display: flex; gap: 1.5rem; align-items: center; padding: 0.75rem 1.5rem; border-bottom: 1px solid var(--border); }
header a { color: var(--fg); text-decoration: none; }
header .brand { font-weight: 700; }
main { max-width: 60rem; margin: 0 auto; padding: 1.5rem; }
.lede { color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 0.5rem; padding: 1rem 1.25rem; margin: 1rem 0; }
.card h2 { margin-top: 0; }
label { display: block; margin: 0.5rem 0; }
input[type="text"], input[type="password"], select { font: inherit; padding: 0.4rem; min-width: 18rem; }
button, .button { font: inherit; padding: 0.45rem 0.9rem; border-radius: 0.375rem; border: 1px solid var(--border); background: var(--card); color: var(--fg); cursor: pointer; text-decoration: none; display: inline-block; }
button.primary, .button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.error { color: var(--err); }
.warning { color: var(--warn); }
.ok { color: var(--ok); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 0.4rem; border-bottom: 1px solid var(--border); vertical-align: top; }
.badge { font-size: 0.85em; padding: 0.1rem 0.45rem; border-radius: 1rem; border: 1px solid currentColor; }
.log { background: #0c0a09; color: #e7e5e4; font-family: ui-monospace, monospace; font-size: 0.85rem; padding: 0.75rem; max-height: 28rem; overflow: auto; white-space: pre-wrap; border-radius: 0.375rem; }
.steps { list-style: none; padding: 0; }
.steps li { padding: 0.4rem 0; border-bottom: 1px solid var(--border); }
code { font-family: ui-monospace, monospace; }
```

`web/src/App.tsx`:

```tsx
import { Connect } from "./pages/Connect.tsx";
import { useRoute } from "./router.ts";

export function App() {
  const route = useRoute();
  return (
    <>
      <header>
        <a className="brand" href="#/connect">
          Switchyard
        </a>
        <nav>
          <a href="#/connect">Connect</a>
        </nav>
      </header>
      <Connect />
    </>
  );
}
```

Tasks 26 and 27 replace `App.tsx` with versions that route to the other pages. Until then, every route shows Connect.

- [ ] **Step 4: Write the Connect screen**

`web/src/pages/Connect.tsx`:

```tsx
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
```

- [ ] **Step 5: Run the tests, the type check and the build**

Run: `pnpm test tests/web && pnpm typecheck && pnpm build:web`
Expected: the router tests pass, `tsc` exits 0, and Vite writes `dist/web/index.html`.

- [ ] **Step 6: Check the screen in a browser**

Run `SWITCHYARD_HOME=$(mktemp -d) pnpm start` and open the printed URL. Check that:
- the three cards render;
- an obviously wrong Vercel token shows "Vercel rejected this token";
- the GitHub card shows "Using gh as …" on this machine;
- the address bar no longer shows `?t=`.

- [ ] **Step 7: Commit**

```bash
git add vite.config.ts web tests/web
git commit -m "feat: add web UI foundation and the Connect screen"
```

---

### Task 26: Projects and Plan review screens

**Files:**
- Create: `web/src/pages/Projects.tsx`, `web/src/pages/PlanReview.tsx`
- Modify: `web/src/App.tsx` (full replacement below)

**Interfaces:**
- Consumes: `api`, `ApiFailure`, `go` and `useRoute` (Task 25), and the types `ProjectSummary` (Task 22), `Job` (Task 17), `MigrationPlan` (Task 16) and `EnvDestination` (Task 11).
- Produces: the `Projects` component, and `PlanReview({ projectId, next }: { projectId: string; next: string[] })`.

- [ ] **Step 1: Write the Projects screen**

`web/src/pages/Projects.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { Job } from "../../../src/pipeline/types.ts";
import type { ProjectSummary } from "../../../src/server/routes/jobs.ts";
import { api, ApiFailure } from "../api.ts";
import { go } from "../router.ts";

const SUPPORT_LABELS = { supported: "Supported", partial: "Partial", unsupported: "Not yet" } as const;

export function Projects() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<ApiFailure | null>(null);

  useEffect(() => {
    api<ProjectSummary[]>("/api/projects")
      .then(setProjects)
      .catch((e: ApiFailure) => setError(e));
    api<Job[]>("/api/jobs")
      .then(setJobs)
      .catch(() => setJobs([]));
  }, []);

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const planSelected = () => {
    const [first, ...rest] = selected;
    if (first) go(`#/plan/${first}${rest.length ? `?next=${rest.join(",")}` : ""}`);
  };

  return (
    <main>
      <h1>Choose projects to move</h1>
      {error && (
        <p className="error">
          {error.message} {error.reconnect && <a href="#/connect">Reconnect {error.reconnect}</a>}
        </p>
      )}
      {!projects && !error && <p>Loading your Vercel projects…</p>}
      {projects && projects.length === 0 && <p>This Vercel token can't see any projects.</p>}
      {projects && projects.length > 0 && (
        <>
          <p className="lede">
            Select one or more projects. You'll review a plan for each before anything changes, and they run one after
            another.
          </p>
          <table>
            <thead>
              <tr>
                <th />
                <th>Project</th>
                <th>Framework</th>
                <th>Repository</th>
                <th>Production branch</th>
                <th>Support</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${p.name}`}
                      disabled={p.support.level === "unsupported" || !p.repo}
                      checked={selected.includes(p.id)}
                      onChange={() => toggle(p.id)}
                    />
                  </td>
                  <td>{p.name}</td>
                  <td>{p.framework ?? "–"}</td>
                  <td>{p.repo ?? "Not linked to Git"}</td>
                  <td>{p.productionBranch ?? "–"}</td>
                  <td>
                    <span className="badge" title={p.support.reason}>
                      {SUPPORT_LABELS[p.support.level]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            <button className="primary" disabled={!selected.length} onClick={planSelected}>
              Review plan{selected.length > 1 ? `s (${selected.length})` : ""}
            </button>
          </p>
        </>
      )}
      {jobs.length > 0 && (
        <section>
          <h2>Migrations</h2>
          <table>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>
                    <a href={`#/jobs/${j.id}`}>{j.plan.projectName}</a>
                  </td>
                  <td>{j.status}</td>
                  <td>{new Date(j.createdAt).toLocaleString("en-GB")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Write the Plan review screen**

`web/src/pages/PlanReview.tsx`:

```tsx
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
```

- [ ] **Step 3: Replace `web/src/App.tsx`**

```tsx
import { Connect } from "./pages/Connect.tsx";
import { PlanReview } from "./pages/PlanReview.tsx";
import { Projects } from "./pages/Projects.tsx";
import { useRoute } from "./router.ts";

export function App() {
  const route = useRoute();
  const next = route.query.get("next")?.split(",").filter(Boolean) ?? [];
  return (
    <>
      <header>
        <a className="brand" href="#/connect">
          Switchyard
        </a>
        <nav>
          <a href="#/connect">Connect</a> <a href="#/projects">Projects</a>
        </nav>
      </header>
      {route.page === "projects" ? (
        <Projects />
      ) : route.page === "plan" && route.id ? (
        <PlanReview key={route.id} projectId={route.id} next={next} />
      ) : (
        <Connect />
      )}
    </>
  );
}
```

- [ ] **Step 4: Type-check and build**

Run: `pnpm typecheck && pnpm build:web`
Expected: both succeed.

- [ ] **Step 5: Check in a browser**

With real accounts connected (Vercel, Cloudflare and gh), open Projects. Check that:
- projects list with support badges;
- unsupported and unlinked projects can't be selected;
- selecting a Next.js project opens its plan;
- Sensitive variables show a password field with Skip;
- Approve stays disabled until each one is filled in or skipped.

Do **not** select Approve yet. That happens in Task 28.

- [ ] **Step 6: Commit**

```bash
git add web
git commit -m "feat: add Projects and Plan review screens"
```

---

### Task 27: Job screen

**Files:**
- Create: `web/src/pages/Job.tsx`
- Modify: `web/src/App.tsx` (full replacement below)

**Interfaces:**
- Consumes: `api`, `apiText` and `authUrl` (Task 25), and the types `Job`, `StepId` and `StepState` (Task 17).
- Produces: `JobPage({ jobId }: { jobId: string })`.

- [ ] **Step 1: Write the Job screen**

`web/src/pages/Job.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { Job, StepId, StepState } from "../../../src/pipeline/types.ts";
import { api, apiText, authUrl } from "../api.ts";

const MAX_LINES = 2000;

const STEP_TITLES: Record<StepId, string> = {
  clone: "Clone the repository",
  convert: "Convert the project",
  build: "Build locally with cf",
  deploy: "Create the Worker with a first deploy",
  push: "Push the migration branch",
  pr: "Open the pull request",
  builds: "Connect Workers Builds",
  "start-build": "Run the first Cloudflare build",
};

const STATUS_LABELS: Record<StepState["status"], string> = {
  pending: "Waiting",
  running: "Running",
  done: "Done",
  failed: "Failed",
  paused: "Needs you",
};

const LINK_OUTPUTS: Record<string, string> = {
  prUrl: "Pull request",
  workersDevUrl: "Deployed Worker",
  buildUrl: "Build log",
};

export function JobPage({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let source: EventSource | null = null;
    let cancelled = false;
    // Load the saved log first, then follow new events.
    apiText(`/api/jobs/${jobId}/log`)
      .then((text) => {
        if (cancelled) return;
        setLines(text.split("\n").filter(Boolean).slice(-MAX_LINES));
        source = new EventSource(authUrl(`/api/jobs/${jobId}/events`));
        source.addEventListener("job", (e) => setJob(JSON.parse((e as MessageEvent<string>).data) as Job));
        source.addEventListener("log", (e) => {
          const { step, line } = JSON.parse((e as MessageEvent<string>).data) as { step: StepId; line: string };
          setLines((l) => [...l, `[${step}] ${line}`].slice(-MAX_LINES));
        });
        source.addEventListener("error", () => {
          if (source?.readyState === EventSource.CLOSED) setError("Lost the connection to Switchyard. Reload to reconnect.");
        });
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
      source?.close();
    };
  }, [jobId]);

  const retry = async () => {
    setBusy(true);
    try {
      setJob(await api<Job>(`/api/jobs/${jobId}/retry`, { method: "POST" }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!job) {
    return (
      <main>
        <p className={error ? "error" : ""}>{error ?? "Loading…"}</p>
      </main>
    );
  }
  const workingCopy = job.steps.find((s) => s.id === "clone")?.outputs.dir;

  return (
    <main>
      <h1>Moving {job.plan.projectName}</h1>
      <p className="lede">Status: {job.status}</p>
      {error && <p className="error">{error}</p>}
      <ol className="steps">
        {job.steps.map((s) => (
          <li key={s.id}>
            <strong>{STEP_TITLES[s.id]}</strong> – <span className={s.status === "failed" ? "error" : s.status === "paused" ? "warning" : s.status === "done" ? "ok" : ""}>{STATUS_LABELS[s.status]}</span>
            {Object.entries(s.outputs)
              .filter(([k]) => k in LINK_OUTPUTS)
              .map(([k, v]) => (
                <div key={k}>
                  {LINK_OUTPUTS[k]}:{" "}
                  <a href={v} target="_blank" rel="noreferrer">
                    {v}
                  </a>
                </div>
              ))}
            {s.error && <p className="error">{s.error}</p>}
            {s.pause && (
              <div className="warning">
                <p>{s.pause.reason}</p>
                {s.pause.actionUrl && (
                  <p>
                    <a className="button" href={s.pause.actionUrl} target="_blank" rel="noreferrer">
                      {s.pause.actionLabel ?? "Open"}
                    </a>
                  </p>
                )}
                {s.pause.reconnect && (
                  <p>
                    <a href="#/connect">Reconnect {s.pause.reconnect}</a>, then select Check again.
                  </p>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
      {(job.status === "failed" || job.status === "paused") && (
        <button className="primary" disabled={busy} onClick={() => void retry()}>
          {job.status === "paused" ? "Check again" : "Retry"}
        </button>
      )}
      {workingCopy && (
        <p>
          Working copy: <code>{workingCopy}</code>{" "}
          <button onClick={() => void navigator.clipboard.writeText(workingCopy)}>Copy path</button>
        </p>
      )}
      <h2>Log</h2>
      <div className="log" role="log">
        {lines.join("\n") || "No output yet."}
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Replace `web/src/App.tsx`**

```tsx
import { Connect } from "./pages/Connect.tsx";
import { JobPage } from "./pages/Job.tsx";
import { PlanReview } from "./pages/PlanReview.tsx";
import { Projects } from "./pages/Projects.tsx";
import { useRoute } from "./router.ts";

export function App() {
  const route = useRoute();
  const next = route.query.get("next")?.split(",").filter(Boolean) ?? [];
  return (
    <>
      <header>
        <a className="brand" href="#/connect">
          Switchyard
        </a>
        <nav>
          <a href="#/connect">Connect</a> <a href="#/projects">Projects</a>
        </nav>
      </header>
      {route.page === "projects" ? (
        <Projects />
      ) : route.page === "plan" && route.id ? (
        <PlanReview key={route.id} projectId={route.id} next={next} />
      ) : route.page === "jobs" && route.id ? (
        <JobPage key={route.id} jobId={route.id} />
      ) : (
        <Connect />
      )}
    </>
  );
}
```

- [ ] **Step 3: Type-check, build and run the full suite**

Run: `pnpm typecheck && pnpm build:web && pnpm test`
Expected: everything passes.

- [ ] **Step 4: Commit**

```bash
git add web
git commit -m "feat: add Job screen with live steps, pauses, retry and log"
```

---

### Task 28: End-to-end run and README

This task runs a real migration, which pushes a branch, opens a PR, creates a Worker and creates Builds triggers. Confirm the target project with the user before Step 3.

**Files:**
- Create: `README.md`

- [ ] **Step 1: Run every automated check**

```bash
pnpm typecheck && pnpm test && pnpm test:fixtures && pnpm build:web
```

Expected: all of them pass.

- [ ] **Step 2: Start Switchyard and connect**

Run `pnpm start` and open the printed link. Then:
1. Paste a Vercel token created by following the guide on the card.
2. Log in with Cloudflare and choose the account from Task 5.
3. Check that GitHub shows "Using gh as MattieTK".

- [ ] **Step 3: Choose a throwaway project (external, confirm first)**

Ask the user which Vercel Next.js project to use. A good choice is a throwaway project linked to the `switchyard-spike` repo from Task 6, with:
- one Sensitive env var,
- one encrypted env var,
- one cron in `vercel.json`.

Don't run against a project the user cares about.

- [ ] **Step 4: Review the plan and run**

On the Plan review screen, check:
- the Sensitive variable asks for a value;
- the cron is listed;
- domains on `*.vercel.app` are not listed.

Enter the value and select Approve and run. Watch the Job screen through all eight steps.

Expected:
- the PR exists on GitHub, with the checklist;
- the `workers.dev` URL serves the app;
- the Cloudflare dashboard shows the two `switchyard-*` triggers on the Worker;
- the first build succeeds.

- [ ] **Step 5: Check pause, resume and recovery**

1. Start a second migration of the same project. It should reuse the open PR and the existing triggers.
2. While its `start-build` step is running, stop the server with Ctrl+C, then restart it.

Expected: the job shows that step as failed with "Switchyard stopped while this step was running", and Retry completes it.

- [ ] **Step 6: Check that no secrets leaked**

Search for both secret values entered in Step 3 (substitute them for the placeholders):

```bash
grep -rF "<the Sensitive value you typed>" ~/.config/switchyard/jobs/ ~/.cache/switchyard/work/*.secrets.json 2>/dev/null; echo "exit $?"
grep -rF "<the encrypted value from Vercel>" ~/.config/switchyard/jobs/*.json ~/.config/switchyard/jobs/*.log; echo "exit $?"
```

Expected: no matches (exit 1). `*.values.json` files exist only for jobs that haven't finished. `.dev.vars` in the working copy is expected to hold development values, and it is git-ignored.

Then run `git -C ~/.cache/switchyard/work/<job id> log -p -1 | grep -F "<the Sensitive value>"`. Expected: no match.

- [ ] **Step 7: Write the README**

`README.md`:

````markdown
# Switchyard

Switchyard moves projects from Vercel to Cloudflare Workers. It runs on your machine, reads a project from Vercel, converts it, deploys it to your Cloudflare account, and connects Workers Builds so later pushes deploy to Cloudflare.

At this point it supports Next.js projects (converted with [vinext](https://github.com/cloudflare/vinext)) that are linked to a GitHub repository.

## What it changes

- **GitHub:** pushes a `cloudflare-migration` branch and opens a pull request. Nothing else is pushed.
- **Cloudflare:** creates a Worker with your production variables as secrets, connects the repository to Workers Builds, and creates two triggers: production (your production branch) and preview (other branches, built but not deployed).
- **Vercel:** nothing. Vercel keeps serving your domains until a later cut-over step.

## Requirements

- Node.js 22.18 or later, and pnpm
- The GitHub CLI logged in (`gh auth login`), or a fine-grained GitHub token
- A Vercel access token (the app shows how to create one)
- A Cloudflare account. You log in through the browser.

## Running it

```bash
pnpm install
pnpm build:web
pnpm start
```

Switchyard opens `http://localhost:4417` in your browser. It only listens on this machine, and the page needs the link printed in the terminal.

Credentials are stored in `~/.config/switchyard/credentials.json`, readable only by you. Working copies are in `~/.cache/switchyard/work`.

## Troubleshooting

- **Port 4417 is already in use:** Switchyard needs this exact port, because the Cloudflare login redirects to it. Stop the other process (`lsof -i :4417`).
- **"Install the GitHub App":** Cloudflare needs its GitHub App on the repository's account or organisation before it can build. Install it, then select Check again.
- **"No Workers Builds token":** open any Worker in the Cloudflare dashboard, go to Settings → Builds and connect a repository once. Then select Check again.
- **Sensitive variables:** Vercel never returns their values. Enter them on the plan screen, or skip them and set them later.

## Development

```bash
pnpm test            # unit tests
pnpm test:fixtures   # converts and builds a real Next.js app with vinext and cf (slow)
pnpm typecheck
```

See `docs/superpowers/specs/` for the design and `docs/spikes.md` for what was checked against the real APIs.
````

- [ ] **Step 8: Commit**

```bash
git add README.md
git commit -m "docs: add README for running Switchyard"
```

- [ ] **Step 9: Report back**

Tell the user:
- what the end-to-end run produced (PR link, Worker URL and build result);
- anything the spikes changed;
- what's left for plan 2 (other frameworks) and plan 3 (cut-over and storage moves).

Ask whether to delete the spike resources and the throwaway Worker and triggers.
