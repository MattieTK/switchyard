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
