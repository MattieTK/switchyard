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
  return Object.entries(NOTES).flatMap(([pkg, note]) => (Object.hasOwn(dependencies, pkg) ? [{ package: pkg, note }] : []));
}
