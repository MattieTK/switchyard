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

  it("adds compatibility flags the Worker lacks", () => {
    const plain = `import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    "name": "rr",
    "compatibilityDate": "2026-10-23",
    "entrypoint": "./workers/app.ts"
  }
});
`;
    const out = editCloudflareConfig(plain, { workerName: "rr", secretKeys: [], crons: [], compatibilityFlags: ["nodejs_compat"] });
    expect(out).toMatch(/compatibilityFlags: \["nodejs_compat"\]/);
    const again = editCloudflareConfig(VINEXT_CONFIG, { workerName: "x", secretKeys: [], crons: [], compatibilityFlags: ["nodejs_compat"] });
    expect(again.match(/nodejs_compat/g)).toHaveLength(1);
  });
});
