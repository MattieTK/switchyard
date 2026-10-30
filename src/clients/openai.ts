import type { ChatGPTTokens } from "../auth/openai-oauth.ts";
import { ApiError, createJsonClient, type FetchFn } from "../http.ts";

// A function the model can call, as the Responses API describes it.
export interface FunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

export interface FunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export type ResponseItem =
  | { type: "function_call"; call_id: string; name: string; arguments: string; id?: string }
  | { type: "message"; content: { type: string; text?: string }[]; id?: string }
  | { type: string; id?: string };

// What a conversation is made of: the user's messages, the model's earlier output and the
// results of its tool calls.
export type InputItem = { role: "user"; content: string } | FunctionCallOutput | ResponseItem;

// Requests are stateless (store: false), which the ChatGPT backend requires, so each one carries
// the whole conversation so far.
export interface ResponseRequest {
  model: string;
  instructions: string;
  input: InputItem[];
  tools?: FunctionTool[];
}

export interface ModelResponse {
  id: string;
  status?: string;
  output: ResponseItem[];
  incomplete_details?: { reason?: string } | null;
}

export interface OpenAIClient {
  // The models that can fix code, best first.
  listModels(): Promise<string[]>;
  respond(req: ResponseRequest): Promise<ModelResponse>;
}

// Reasoning models' reasoning goes back to them encrypted, since nothing is stored between requests.
const REASONING_MODEL = /^(gpt-5|o\d|codex)/;

// With an API key, on OpenAI's public API, billed to the key's organisation.
export function createOpenAIClient(o: { fetch: FetchFn; apiKey: string }): OpenAIClient {
  const http = createJsonClient({
    service: "openai",
    baseUrl: "https://api.openai.com/v1",
    fetch: o.fetch,
    token: async () => o.apiKey,
    errorMessage: (b) => (b as { error?: { message?: string } } | null)?.error?.message,
  });
  return {
    listModels: async () => codeModels((await http.request<{ data: { id: string }[] }>("/models")).data.map((m) => m.id)),
    respond: (req) =>
      http.request<ModelResponse>("/responses", {
        method: "POST",
        body: { ...req, store: false, ...(REASONING_MODEL.test(req.model) ? { include: ["reasoning.encrypted_content"] } : {}) },
      }),
  };
}

export const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";

// With the user's ChatGPT sign-in, on the backend Codex uses, within their plan's usage limits.
// OpenAI asks other apps there to name themselves rather than pass as Codex, as Hermes Agent does.
export function createChatGPTClient(o: { fetch: FetchFn; tokens: () => Promise<ChatGPTTokens>; version: string }): OpenAIClient {
  async function headers(accept: string): Promise<Record<string, string>> {
    const t = await o.tokens();
    return {
      Authorization: `Bearer ${t.accessToken}`,
      ...(t.accountId ? { "ChatGPT-Account-ID": t.accountId } : {}),
      originator: "switchyard",
      "User-Agent": `Switchyard/${o.version}`,
      Accept: accept,
    };
  }
  async function fail(res: Response): Promise<never> {
    const text = await res.text().catch(() => "");
    let message = text.slice(0, 500) || res.statusText;
    try {
      const b = JSON.parse(text) as { error?: { message?: string } | string; detail?: string | { message?: string } };
      message =
        (typeof b.error === "string" ? b.error : b.error?.message) ??
        (typeof b.detail === "string" ? b.detail : b.detail?.message) ??
        message;
    } catch {
      // Not JSON; the start of the text will do.
    }
    if (res.status === 429) message = `ChatGPT's usage limit was reached (${message}). Try again once it resets.`;
    throw new ApiError("openai", res.status, message, res.status === 401);
  }

  return {
    // The catalog lists the models the user's plan can use, best first. It answers with an empty
    // list for a client version it doesn't know, so the version Codex treats as "any" comes second.
    async listModels() {
      for (const version of ["99.0.0", "0.0.0"]) {
        const res = await o.fetch(`${CHATGPT_BASE_URL}/models?client_version=${version}`, { headers: await headers("application/json") });
        if (res.status === 401) await fail(res);
        if (!res.ok) continue;
        const models = catalogModels(await res.json());
        if (models.length) return models;
      }
      return [];
    },
    async respond(req) {
      const res = await o.fetch(`${CHATGPT_BASE_URL}/responses`, {
        method: "POST",
        headers: { ...(await headers("text/event-stream")), "Content-Type": "application/json" },
        body: JSON.stringify({
          ...req,
          tool_choice: "auto",
          parallel_tool_calls: true,
          store: false,
          stream: true,
          include: ["reasoning.encrypted_content"],
        }),
      });
      if (!res.ok) await fail(res);
      return parseResponseStream(await res.text());
    },
  };
}

// The visible models in the ChatGPT backend's catalog, by its priority.
export function catalogModels(body: unknown): string[] {
  const entries = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(entries)) return [];
  const ranked = entries.flatMap((e: { slug?: unknown; visibility?: unknown; priority?: unknown }) =>
    typeof e?.slug === "string" && e.slug.trim() && !["hide", "hidden"].includes(String(e.visibility ?? "").toLowerCase())
      ? [{ slug: e.slug.trim(), rank: typeof e.priority === "number" ? e.priority : 10_000 }]
      : [],
  );
  return [...new Set(ranked.sort((a, b) => a.rank - b.rank || a.slug.localeCompare(b.slug)).map((e) => e.slug))];
}

// A streamed response as one: its output items in order. The final event's output can be empty,
// so the items are also collected as each one finishes.
export function parseResponseStream(text: string): ModelResponse {
  const done: { index: number; item: ResponseItem }[] = [];
  let final: ModelResponse | null = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    let event: {
      type?: string;
      item?: ResponseItem;
      output_index?: number;
      response?: ModelResponse & { error?: { message?: string } | null };
      message?: string;
      error?: { message?: string };
    };
    try {
      event = JSON.parse(data) as typeof event;
    } catch {
      continue;
    }
    if (event.type === "response.output_item.done" && event.item) done.push({ index: event.output_index ?? done.length, item: event.item });
    else if (event.type === "response.completed" || event.type === "response.incomplete") final = event.response ?? null;
    else if (event.type === "response.failed") throw new ApiError("openai", 502, event.response?.error?.message ?? "The response failed.");
    else if (event.type === "error") throw new ApiError("openai", 502, event.message ?? event.error?.message ?? "The response failed.");
  }
  if (!final && !done.length) throw new ApiError("openai", 502, "The response ended before it finished.");
  const output = final?.output?.length ? final.output : done.sort((a, b) => a.index - b.index).map((d) => d.item);
  return { id: final?.id ?? "", status: final?.status, output, incomplete_details: final?.incomplete_details ?? null };
}

// The text the model wrote in a response, outside its tool calls.
export function responseText(r: ModelResponse): string {
  return r.output
    .flatMap((item) => (item.type === "message" && "content" in item ? item.content : []))
    .map((c) => c.text ?? "")
    .join("\n")
    .trim();
}

// Models for other kinds of work, which can't edit code with tools.
const NOT_FOR_CODE = /audio|realtime|image|tts|transcribe|search|embedding|moderation|instruct|dall-e|whisper|davinci|babbage|chat-latest|oss/;
// Dated snapshots, such as gpt-5-2025-08-07, repeat a model already listed under its own name.
const SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;
// Full-size models first, then mini and nano, then pro ones, which are much slower and dearer.
const tier = (id: string) => (/-pro\b/.test(id) ? 2 : /-(mini|nano)\b/.test(id) ? 1 : 0);

// The models an API key lists that can fix code, best first: the newest GPT version, then by
// size, and a Codex variant before its general one. OpenAI renames and retires models often, so
// this ranks what the key can use rather than naming one.
export function codeModels(ids: readonly string[]): string[] {
  const version = (id: string) => {
    const m = id.match(/^gpt-(\d+)(?:\.(\d+))?/);
    return m ? Number(m[1]) * 1000 + Number(m[2] ?? 0) : -1;
  };
  return [...new Set(ids)]
    .filter((id) => /^(gpt-\d|o\d|codex)/.test(id) && !NOT_FOR_CODE.test(id) && !SNAPSHOT.test(id))
    .sort(
      (a, b) =>
        version(b) - version(a) ||
        tier(a) - tier(b) ||
        Number(b.includes("codex")) - Number(a.includes("codex")) ||
        a.localeCompare(b),
    );
}
