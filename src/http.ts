export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export type Service = "vercel" | "cloudflare" | "github";

export class ApiError extends Error {
  readonly service: Service;
  readonly status: number;
  readonly auth: boolean;

  constructor(service: Service, status: number, message: string, auth = false) {
    super(`${service} API error ${status}: ${message}`);
    this.name = "ApiError";
    this.service = service;
    this.status = status;
    this.auth = auth;
  }
}

export function isAuthError(e: unknown): e is ApiError {
  return e instanceof ApiError && e.auth;
}

export interface JsonRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  allow404?: boolean;
  // "bytes" returns the response body as a Uint8Array, for binary responses such as images.
  as?: "json" | "bytes";
}

export interface JsonClient {
  request<T>(path: string, req?: JsonRequest): Promise<T>;
}

export interface JsonClientOptions {
  service: Service;
  baseUrl: string;
  fetch: FetchFn;
  token: () => Promise<string>;
  errorMessage: (body: unknown) => string | undefined;
  isAuthFailure?: (status: number, body: unknown) => boolean;
  headers?: Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createJsonClient(o: JsonClientOptions): JsonClient {
  const sleep = o.sleep ?? defaultSleep;
  const maxRetries = o.maxRetries ?? 3;

  return {
    async request<T>(path: string, req: JsonRequest = {}): Promise<T> {
      const url = new URL(o.baseUrl + path);
      for (const [k, v] of Object.entries(req.query ?? {})) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
      const hasBody = req.body !== undefined;

      for (let attempt = 0; ; attempt++) {
        const res = await o.fetch(url.toString(), {
          method: req.method ?? "GET",
          headers: {
            Authorization: `Bearer ${await o.token()}`,
            Accept: req.as === "bytes" ? "*/*" : "application/json",
            ...(hasBody ? { "Content-Type": "application/json" } : {}),
            ...o.headers,
          },
          body: hasBody ? JSON.stringify(req.body) : undefined,
        });

        if (res.ok) {
          if (req.as === "bytes") return new Uint8Array(await res.arrayBuffer()) as T;
          if (res.status === 204) return undefined as T;
          const text = await res.text();
          try {
            return (text ? JSON.parse(text) : undefined) as T;
          } catch {
            throw new ApiError(o.service, res.status, "Response was not valid JSON");
          }
        }
        if (res.status === 404 && req.allow404) return null as T;

        const body = await readBody(res);
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < maxRetries) {
          await sleep(retryDelay(res, attempt));
          continue;
        }
        const auth = res.status === 401 || (o.isAuthFailure?.(res.status, body) ?? false);
        throw new ApiError(o.service, res.status, o.errorMessage(body) ?? res.statusText, auth);
      }
    },
  };
}

function retryDelay(res: Response, attempt: number): number {
  const after = Number(res.headers.get("retry-after"));
  if (Number.isFinite(after) && after > 0) return Math.min(after, 60) * 1000;
  return 500 * 2 ** attempt;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
