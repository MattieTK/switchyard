import { describe, expect, it } from "vitest";
import { useNativeFetch } from "../../src/codegen/native-fetch.ts";

describe("useNativeFetch", () => {
  it("drops imports of fetch polyfills that bind the built-in names, keeping the rest of the file as it was", () => {
    const code = `import Head from "next/head";
import fetch from "isomorphic-fetch";
import _ from "lodash";

export async function getServerSideProps() {
  const r = await fetch("https://example.com");
  return { props: {  data: await r.json() } };
}
`;
    expect(useNativeFetch(code)).toEqual({
      code: `import Head from "next/head";
import _ from "lodash";

export async function getServerSideProps() {
  const r = await fetch("https://example.com");
  return { props: {  data: await r.json() } };
}
`,
      replaced: ["isomorphic-fetch"],
      kept: [],
    });
  });

  it("handles side-effect imports, named imports, other local names and require()", () => {
    expect(useNativeFetch('import "whatwg-fetch";\nfetch("/a");\n').code).toBe('fetch("/a");\n');
    expect(useNativeFetch('import fetch, { Headers, Response as R } from "node-fetch";\nnew R();\n').code).toBe(
      "const R = Response;\nnew R();\n",
    );
    expect(useNativeFetch('import nodeFetch from "node-fetch";\nnodeFetch("/a");\n').code).toBe(
      'const nodeFetch = fetch;\nnodeFetch("/a");\n',
    );
    expect(useNativeFetch('const fetch = require("node-fetch");\nfetch("/a");\n').code).toBe('fetch("/a");\n');
    expect(useNativeFetch('const f = require("cross-fetch").default;\nf("/a");\n').code).toBe('const f = fetch;\nf("/a");\n');
    expect(useNativeFetch('const { Headers } = require("@whatwg-node/fetch");\nnew Headers();\n').code).toBe("new Headers();\n");
    expect(useNativeFetch('require("isomorphic-unfetch");\nfetch("/a");\n').code).toBe('fetch("/a");\n');
  });

  it("parses TypeScript and JSX", () => {
    const tsx = 'import fetch from "isomorphic-unfetch";\nconst a: number = 1;\nexport const C = () => <div>{a}</div>;\n';
    expect(useNativeFetch(tsx, "page.tsx").code).toBe("const a: number = 1;\nexport const C = () => <div>{a}</div>;\n");
  });

  it("keeps imports it can't replace exactly, and says which packages are still imported", () => {
    for (const code of [
      'import fetch, { FetchError } from "node-fetch";\n',
      'import * as nodeFetch from "node-fetch";\n',
      'const fetch = await import("node-fetch");\n',
      'import type { RequestInit } from "node-fetch";\n',
    ]) {
      expect(useNativeFetch(code)).toEqual({ code: null, replaced: [], kept: ["node-fetch"] });
    }
  });

  it("leaves files that don't import a fetch polyfill alone, including ones it can't parse", () => {
    expect(useNativeFetch('import axios from "axios";\n')).toEqual({ code: null, replaced: [], kept: [] });
    expect(useNativeFetch("this is not { javascript")).toEqual({ code: null, replaced: [], kept: [] });
  });
});
