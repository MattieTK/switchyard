import type { FetchFn } from "../../src/http.ts";

export interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

type Responder = Response | ((url: string, init?: RequestInit) => Response);

export function fakeFetch(responses: Responder[]): { fetch: FetchFn; calls: RecordedCall[] } {
  const queue = [...responses];
  const calls: RecordedCall[] = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    return typeof next === "function" ? next(url, init) : next;
  };
  return { fetch, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
