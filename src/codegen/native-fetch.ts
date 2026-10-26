import { generateCode, parseModule } from "magicast";

// Packages that stand in for the fetch API where a platform lacked it. Workers has fetch built in,
// and these packages' Node.js versions can break once bundled for it: isomorphic-fetch requires
// node-fetch, gets its ES module build and fails with "n.call is not a function". The list is the
// fetch-compatible entries of e18e's module-replacements "preferred" manifest, plus unfetch.
export const FETCH_POLYFILLS = [
  "isomorphic-fetch",
  "node-fetch",
  "cross-fetch",
  "whatwg-fetch",
  "@whatwg-node/fetch",
  "isomorphic-unfetch",
  "unfetch",
];

// What a default import or require() of these packages gives, and the named exports that match
// globals Workers provides. Anything else (FetchError, AbortError, …) has no built-in equivalent.
const GLOBALS = new Set(["fetch", "Headers", "Request", "Response", "FormData", "Blob", "File"]);

export interface NativeFetchResult {
  // The rewritten source, or null when nothing changed.
  code: string | null;
  // Packages whose imports were replaced, and packages still imported afterwards.
  replaced: string[];
  kept: string[];
}

// Minimal shapes of the Babel AST nodes this reads.
type Node = { type: string; [key: string]: any };

const mentioned = (code: string) =>
  FETCH_POLYFILLS.filter((p) => new RegExp(`['"\`]${p.replace(/[/.]/g, "\\$&")}['"\`]`).test(code));

// require("pkg") or require("pkg").default, giving the package name.
function requiredPackage(init: Node | null | undefined): string | null {
  const call = init?.type === "MemberExpression" && !init.computed && init.property?.name === "default" ? init.object : init;
  if (call?.type !== "CallExpression" || call.callee?.type !== "Identifier" || call.callee.name !== "require") return null;
  const [arg] = call.arguments ?? [];
  const name = arg?.type === "StringLiteral" || arg?.type === "Literal" ? String(arg.value) : null;
  return name && FETCH_POLYFILLS.includes(name) ? name : null;
}

// Bindings as [local name, global] pairs, or null when any can't be matched to a global.
function importBindings(node: Node): [string, string][] | null {
  if (node.importKind === "type") return null;
  const pairs: [string, string][] = [];
  for (const s of node.specifiers ?? []) {
    if (s.importKind === "type") return null;
    const global =
      s.type === "ImportDefaultSpecifier" ? "fetch" : s.type === "ImportSpecifier" ? (s.imported?.name ?? s.imported?.value) : null;
    if (!global || !GLOBALS.has(global)) return null;
    pairs.push([s.local.name, global]);
  }
  return pairs;
}

function requireBindings(id: Node, init: Node): [string, string][] | null {
  if (id.type === "Identifier") return [[id.name, "fetch"]];
  if (id.type !== "ObjectPattern" || init.type === "MemberExpression") return null;
  const pairs: [string, string][] = [];
  for (const p of id.properties ?? []) {
    const key = p.type === "ObjectProperty" || p.type === "Property" ? (p.key?.name ?? p.key?.value) : null;
    if (p.computed || !key || !GLOBALS.has(key) || p.value?.type !== "Identifier") return null;
    pairs.push([p.value.name, key]);
  }
  return pairs;
}

// `const local = Global;` for each binding whose local name differs from the global's.
const aliases = (pairs: [string, string][]): Node[] =>
  pairs
    .filter(([local, global]) => local !== global)
    .map(([local, global]) => (parseModule(`const ${local} = ${global};`).$ast as Node).body[0]);

// Replaces top-level imports and require() calls of fetch polyfills with the built-in globals.
// Imports it can't replace exactly are kept and reported, so the file still works as before.
export function useNativeFetch(code: string, _filename?: string): NativeFetchResult {
  const packages = mentioned(code);
  if (!packages.length) return { code: null, replaced: [], kept: [] };
  let mod: ReturnType<typeof parseModule>;
  try {
    mod = parseModule(code);
  } catch {
    return { code: null, replaced: [], kept: packages };
  }
  const body = (mod.$ast as Node).body as Node[];
  const replaced = new Set<string>();
  const next: Node[] = [];
  for (const node of body) {
    const source = node.type === "ImportDeclaration" ? String(node.source.value) : null;
    if (source && FETCH_POLYFILLS.includes(source)) {
      const pairs = importBindings(node);
      if (pairs) {
        next.push(...aliases(pairs));
        replaced.add(source);
        continue;
      }
    }
    if (node.type === "ExpressionStatement") {
      const name = requiredPackage(node.expression);
      if (name) {
        replaced.add(name);
        continue;
      }
    }
    if (node.type === "VariableDeclaration" && node.declarations.some((d: Node) => requiredPackage(d.init))) {
      const pairs = node.declarations.map((d: Node) => (requiredPackage(d.init) ? requireBindings(d.id, d.init) : null));
      if (pairs.every((p: unknown) => p !== null)) {
        for (const d of node.declarations as Node[]) replaced.add(requiredPackage(d.init) ?? "");
        next.push(...aliases(pairs.flat()));
        continue;
      }
    }
    next.push(node);
  }
  if (!replaced.size) return { code: null, replaced: [], kept: packages };
  body.splice(0, body.length, ...next);
  // The printer drops the file's final newline once the body has changed.
  const printed = generateCode(mod).code;
  const out = code.endsWith("\n") && !printed.endsWith("\n") ? `${printed}\n` : printed;
  return { code: out, replaced: [...replaced], kept: mentioned(out) };
}
