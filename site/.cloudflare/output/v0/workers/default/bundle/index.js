//#region src/logo.ts
var LOGO_PNG_BASE64 = "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";
var LOGO_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"512\" height=\"512\" viewBox=\"0 0 512 512\">\n  <rect width=\"512\" height=\"512\" rx=\"112\" fill=\"#18181b\"/>\n  <g transform=\"translate(96 96) scale(16)\" fill=\"none\" stroke=\"#fafafa\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n    <path d=\"M3 16V10c0-3 2-5 5-5h9\"/>\n    <path d=\"M3 10v-6\"/>\n    <path d=\"M13 2l4 3-4 3\"/>\n  </g>\n</svg>\n";
//#endregion
//#region src/index.ts
var PAGE = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Switchyard</title>
<meta name="description" content="Switchyard moves projects from Vercel to Cloudflare Workers, running on your own computer.">
<link rel="icon" href="/logo.svg" type="image/svg+xml">
<style>
  :root { --bg: #fafafa; --surface: #fff; --fg: #18181b; --muted: #71717a; --border: #e4e4e7; --accent: #2563eb;
    color-scheme: light; font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #09090b; --surface: #111113; --fg: #fafafa; --muted: #a1a1aa; --border: #27272a; --accent: #60a5fa; color-scheme: dark; }
  }
  body { margin: 0; background: var(--bg); }
  main { max-width: 40rem; margin: 0 auto; padding: 4rem 1.25rem 5rem; }
  header { display: flex; align-items: center; gap: 0.9rem; margin-bottom: 2rem; }
  header img { width: 3rem; height: 3rem; border-radius: 0.7rem; }
  h1 { font-size: 1.9rem; letter-spacing: -0.02em; margin: 0; }
  h2 { font-size: 1.05rem; margin: 2.25rem 0 0.5rem; }
  p, li { color: var(--fg); }
  .lede { font-size: 1.1rem; color: var(--muted); margin-top: 0; }
  ul { padding-left: 1.2rem; }
  li + li { margin-top: 0.35rem; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.25rem; }
  .muted { color: var(--muted); font-size: 0.92rem; }
  a { color: var(--accent); }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 0.9em; }
</style>
</head>
<body>
<main>
  <header>
    <img src="/logo.svg" alt="">
    <h1>Switchyard</h1>
  </header>
  <p class="lede">Switchyard moves projects from Vercel to Cloudflare Workers. It runs on your own computer.</p>
  <p>You connect your Vercel account with a token, log in to Cloudflare and choose projects. For each one, Switchyard converts the code, copies its environment variables, deploys it as a Worker and opens a pull request on GitHub, so you can review everything before switching traffic.</p>

  <h2>What Switchyard asks Cloudflare for</h2>
  <div class="card">
    <ul>
      <li><strong>Workers and Workers Builds</strong>, to create the Worker, set its secrets and connect builds to your repository.</li>
      <li><strong>Storage</strong> such as KV, R2 and D1, so migrated apps can keep their caches and data.</li>
      <li><strong>Zones and DNS</strong>, to move your domains once you're ready.</li>
      <li><strong>The rest of the developer platform</strong>, including Queues, AI, Vectorize and Containers, so migrated apps can use them without another login.</li>
      <li><strong>Your profile and account list</strong>, to show who you're logged in as and let you choose where to deploy.</li>
    </ul>
  </div>

  <h2>Where your data goes</h2>
  <p>Tokens are stored only on your computer. Switchyard has no hosted service: it talks directly to Vercel, Cloudflare and GitHub, and nothing else.</p>

  <h2>Revoking access</h2>
  <p>You can remove Switchyard's access at any time in the Cloudflare dashboard, under <strong>My Profile &gt; Access Management &gt; Connected Applications</strong>.</p>

  <p class="muted">This page exists so Cloudflare can verify who publishes Switchyard's login.</p>
</main>
</body>
</html>`;
function decodeBase64(value) {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
var LOGO_PNG = decodeBase64(LOGO_PNG_BASE64);
var CACHE = "public, max-age=3600";
//#endregion
//#region \0virtual:cloudflare/worker-entry
var worker_entry_default = { fetch(request) {
	const { pathname } = new URL(request.url);
	switch (pathname) {
		case "/": return new Response(PAGE, { headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": CACHE
		} });
		case "/logo.png": return new Response(LOGO_PNG, { headers: {
			"content-type": "image/png",
			"cache-control": CACHE
		} });
		case "/logo.svg": return new Response(LOGO_SVG, { headers: {
			"content-type": "image/svg+xml",
			"cache-control": CACHE
		} });
		default: return new Response("Not found", { status: 404 });
	}
} };
//#endregion
export { worker_entry_default as default };

//# sourceMappingURL=index.js.map