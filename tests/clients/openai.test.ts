import { describe, expect, it } from "vitest";
import {
  catalogModels,
  codeModels,
  createChatGPTClient,
  createOpenAIClient,
  parseResponseStream,
  responseText,
} from "../../src/clients/openai.ts";
import { isAuthError } from "../../src/http.ts";
import { fakeFetch, json } from "../helpers/fake-fetch.ts";

describe("createOpenAIClient", () => {
  it("lists models and sends responses with the key", async () => {
    const f = fakeFetch([json({ data: [{ id: "gpt-5.5" }, { id: "gpt-image-2" }] }), json({ id: "resp_1", output: [] })]);
    const c = createOpenAIClient({ fetch: f.fetch, apiKey: "sk-test" });
    expect(await c.listModels()).toEqual(["gpt-5.5"]);
    await c.respond({ model: "gpt-5.5", instructions: "Fix it.", input: [{ role: "user", content: "hi" }] });
    expect(f.calls[0]?.url).toBe("https://api.openai.com/v1/models");
    expect(f.calls[1]?.url).toBe("https://api.openai.com/v1/responses");
    expect(new Headers(f.calls[1]?.init?.headers).get("authorization")).toBe("Bearer sk-test");
    expect(JSON.parse(String(f.calls[1]?.init?.body))).toEqual({
      model: "gpt-5.5",
      instructions: "Fix it.",
      input: [{ role: "user", content: "hi" }],
      store: false,
      include: ["reasoning.encrypted_content"],
    });
  });

  it("reports a rejected key as an auth error with OpenAI's message", async () => {
    const f = fakeFetch([json({ error: { message: "Incorrect API key provided" } }, 401)]);
    const e = await createOpenAIClient({ fetch: f.fetch, apiKey: "bad" }).listModels().catch((x: unknown) => x);
    expect(isAuthError(e)).toBe(true);
    expect((e as Error).message).toContain("Incorrect API key provided");
  });
});

describe("responseText", () => {
  it("joins the text of message items and ignores tool calls", () => {
    expect(
      responseText({
        id: "r",
        output: [
          { type: "reasoning" },
          { type: "message", content: [{ type: "output_text", text: "Found it." }] },
          { type: "function_call", call_id: "c", name: "read_file", arguments: "{}" },
        ],
      }),
    ).toBe("Found it.");
  });
});

describe("codeModels", () => {
  it("keeps models that write code, newest and full-size first, Codex before its general model", () => {
    expect(
      codeModels([
        "gpt-4o",
        "gpt-5.5-pro",
        "gpt-5.2-codex",
        "gpt-5.5",
        "gpt-5.4-mini",
        "gpt-5.2",
        "gpt-5-2025-08-07",
        "gpt-image-2",
        "gpt-4o-realtime-preview",
        "text-embedding-3-large",
        "o3",
        "gpt-5.5",
      ]),
    ).toEqual(["gpt-5.5", "gpt-5.5-pro", "gpt-5.4-mini", "gpt-5.2-codex", "gpt-5.2", "gpt-4o", "o3"]);
  });

  it("ranks named variants of a version, such as the GPT-5.6 family, above older versions", () => {
    expect(codeModels(["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra"])).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"]);
  });
});

const sse = (...events: unknown[]) =>
  new Response(events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

describe("createChatGPTClient", () => {
  const tokens = async () => ({ accessToken: "at", refreshToken: "rt", expiresAt: 0, accountId: "acct-1" });

  it("calls the Codex backend as Switchyard, for the signed-in account, streamed and stateless", async () => {
    const call = { type: "function_call", id: "fc_1", call_id: "c1", name: "read_file", arguments: "{}" };
    const f = fakeFetch([
      sse(
        { type: "response.output_item.done", output_index: 0, item: call },
        { type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } },
      ),
    ]);
    const c = createChatGPTClient({ fetch: f.fetch, tokens, version: "0.1.0" });
    const r = await c.respond({ model: "gpt-5.5", instructions: "Fix it.", input: [{ role: "user", content: "hi" }] });
    expect(r).toMatchObject({ id: "resp_1", output: [call] });
    expect(f.calls[0]?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    const headers = new Headers(f.calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer at");
    expect(headers.get("chatgpt-account-id")).toBe("acct-1");
    expect(headers.get("originator")).toBe("switchyard");
    expect(headers.get("user-agent")).toBe("Switchyard/0.1.0");
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toMatchObject({ store: false, stream: true, include: ["reasoning.encrypted_content"] });
  });

  it("explains a usage limit and treats a rejected token as signed out", async () => {
    const c = (res: Response) => createChatGPTClient({ fetch: fakeFetch([res]).fetch, tokens, version: "0.1.0" });
    const req = { model: "gpt-5.5", instructions: "", input: [] };
    await expect(c(json({ detail: "Usage limit reached" }, 429)).respond(req)).rejects.toThrow("ChatGPT's usage limit was reached");
    expect(isAuthError(await c(json({ detail: "expired" }, 401)).respond(req).catch((e: unknown) => e))).toBe(true);
  });

  it("lists the plan's models, asking again as any client version when the newest gets none", async () => {
    const f = fakeFetch([
      json({ models: [] }),
      json({ models: [{ slug: "gpt-5.4", priority: 2 }, { slug: "gpt-5.5", priority: 1 }, { slug: "secret", visibility: "hide" }] }),
    ]);
    expect(await createChatGPTClient({ fetch: f.fetch, tokens, version: "0.1.0" }).listModels()).toEqual(["gpt-5.5", "gpt-5.4"]);
    expect(f.calls.map((x) => x.url)).toEqual([
      "https://chatgpt.com/backend-api/codex/models?client_version=99.0.0",
      "https://chatgpt.com/backend-api/codex/models?client_version=0.0.0",
    ]);
  });
});

describe("parseResponseStream", () => {
  it("prefers the final output, and reports failures", () => {
    const item = { type: "message", content: [{ type: "output_text", text: "Done" }] };
    const text = [
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning" } },
      { type: "response.completed", response: { id: "r", output: [item] } },
    ]
      .map((e) => `data: ${JSON.stringify(e)}\n\n`)
      .join("");
    expect(parseResponseStream(text).output).toEqual([item]);
    expect(() => parseResponseStream(`data: ${JSON.stringify({ type: "response.failed", response: { error: { message: "Overloaded" } } })}\n\n`)).toThrow("Overloaded");
    expect(() => parseResponseStream("")).toThrow("ended before it finished");
  });

  it("ignores catalog entries without a slug", () => {
    expect(catalogModels({ models: [{ priority: 1 }, { slug: "gpt-5.5" }] })).toEqual(["gpt-5.5"]);
    expect(catalogModels(null)).toEqual([]);
  });
});
