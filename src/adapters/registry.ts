import { reactRouterAdapter, viteAdapter } from "./cf-init.ts";
import { nextjsAdapter } from "./nextjs.ts";
import { detectedFrameworks } from "./shared.ts";
import { STATIC_PRESETS, staticAdapter } from "./static.ts";
import type { Adapter, DetectInput, Support } from "./types.ts";

// Most specific first: React Router and Next.js apps also depend on Vite, and the static adapter
// takes what's left.
export const ADAPTERS: readonly Adapter[] = [nextjsAdapter, reactRouterAdapter, viteAdapter, staticAdapter];

// Vercel's framework slugs, as people know the frameworks.
const FRAMEWORK_NAMES: Readonly<Record<string, string>> = {
  nextjs: "Next.js",
  vite: "Vite",
  "react-router": "React Router",
  remix: "Remix",
  astro: "Astro",
  sveltekit: "SvelteKit",
  "sveltekit-1": "SvelteKit",
  nuxtjs: "Nuxt",
  angular: "Angular",
  "ionic-angular": "Ionic Angular",
  scully: "Scully",
  solidstart: "SolidStart",
  "solidstart-1": "SolidStart",
  "tanstack-start": "TanStack Start",
  qwik: "Qwik",
  redwoodjs: "RedwoodJS",
  hydrogen: "Hydrogen",
  vitepress: "VitePress",
  vuepress: "VuePress",
  hugo: "Hugo",
  jekyll: "Jekyll",
  middleman: "Middleman",
  zola: "Zola",
  hono: "Hono",
  express: "Express",
  nestjs: "NestJS",
  fastify: "Fastify",
  nitro: "Nitro",
  ...Object.fromEntries(Object.entries(STATIC_PRESETS).map(([slug, p]) => [slug, p.name])),
};

export function frameworkName(slug: string | null): string | null {
  return slug === null ? null : (FRAMEWORK_NAMES[slug] ?? slug);
}

// Why a framework can't move yet, where there's more to say than that it isn't supported.
const NOT_YET: Readonly<Record<string, string>> = {
  remix: "Remix 2 apps need upgrading to React Router 7 first. Once the app uses React Router 7, Switchyard can move it.",
  astro: "The Cloudflare build tool (cf) can't build Astro projects yet.",
  sveltekit: "The Cloudflare build tool (cf) doesn't support SvelteKit yet.",
  "sveltekit-1": "The Cloudflare build tool (cf) doesn't support SvelteKit yet.",
  nuxtjs: "The Cloudflare build tool (cf) doesn't support Nuxt yet.",
  angular: "The Cloudflare build tool (cf) doesn't support Angular yet.",
  "ionic-angular": "The Cloudflare build tool (cf) doesn't support Angular yet.",
  scully: "The Cloudflare build tool (cf) doesn't support Angular yet.",
  solidstart: "The Cloudflare build tool (cf) doesn't support SolidStart yet.",
  "solidstart-1": "The Cloudflare build tool (cf) doesn't support SolidStart yet.",
  qwik: "The Cloudflare build tool (cf) doesn't support Qwik yet.",
  hugo: "Switchyard only builds JavaScript projects so far, and Hugo sites build with Hugo itself.",
  jekyll: "Switchyard only builds JavaScript projects so far, and Jekyll sites build with Ruby.",
  middleman: "Switchyard only builds JavaScript projects so far, and Middleman sites build with Ruby.",
  zola: "Switchyard only builds JavaScript projects so far, and Zola sites build with Zola itself.",
  express: "Node.js servers aren't supported yet.",
  nestjs: "Node.js servers aren't supported yet.",
  fastify: "Node.js servers aren't supported yet.",
  hono: "Hono apps aren't supported yet.",
};

function unsupported(input: DetectInput): Support {
  const { vercelFramework: framework } = input;
  const known = framework ? NOT_YET[framework] : undefined;
  if (known) return { level: "unsupported", reason: known };
  // A framework found in package.json, that cf would build itself.
  const found = detectedFrameworks(input.packageJson).map(([, name]) => name);
  const preset = framework ? STATIC_PRESETS[framework] : undefined;
  if (preset && found.length) {
    return {
      level: "unsupported",
      reason: `This ${preset.name} project depends on ${found.join(" and ")}, so the Cloudflare build tool (cf) would build it as a ${found.join(" and ")} app instead. Switchyard can't move it yet.`,
    };
  }
  if (found.length) {
    return {
      level: "unsupported",
      reason: `This project uses ${found.join(" and ")}, which Switchyard can't move yet.`,
    };
  }
  return {
    level: "unsupported",
    reason: framework ? `${frameworkName(framework)} projects aren't supported yet.` : "Vercel didn't detect a framework.",
  };
}

export function adapterById(id: string | null): Adapter | null {
  return ADAPTERS.find((a) => a.id === id) ?? null;
}

export function pickAdapter(input: DetectInput): { adapter: Adapter | null; support: Support } {
  // A framework Switchyard knows it can't move yet isn't handed to the static adapter.
  const adapter = input.vercelFramework && NOT_YET[input.vercelFramework] ? null : (ADAPTERS.find((a) => a.matches(input)) ?? null);
  return adapter ? { adapter, support: adapter.supportFor?.(input) ?? adapter.support } : { adapter: null, support: unsupported(input) };
}

// For the project list, where package.json hasn't been fetched yet.
export function supportForFramework(framework: string | null): Support {
  return pickAdapter({ vercelFramework: framework, packageJson: null }).support;
}
