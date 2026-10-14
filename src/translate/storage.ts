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
      ...rule.deps.filter((d) => Object.hasOwn(input.dependencies, d)),
    ];
    return evidence.length ? [{ kind: rule.kind, label: rule.label, evidence, suggestion: rule.suggestion }] : [];
  });
}
