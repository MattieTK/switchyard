const KEY = "switchyard-launch-token";

// The launch token arrives once in the URL (?t=…). Keep it for this tab only
// and remove it from the address bar so it isn't copied around by accident.
function readLaunchToken(): string {
  const fromUrl = new URLSearchParams(location.search).get("t");
  if (fromUrl) {
    sessionStorage.setItem(KEY, fromUrl);
    history.replaceState(null, "", location.pathname + location.hash);
    return fromUrl;
  }
  return sessionStorage.getItem(KEY) ?? "";
}

const token = readLaunchToken();

export class ApiFailure extends Error {
  readonly reconnect?: string;

  constructor(message: string, reconnect?: string) {
    super(message);
    this.name = "ApiFailure";
    this.reconnect = reconnect;
  }
}

async function request(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: {
      "x-switchyard-token": token,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; reconnect?: string };
    throw new ApiFailure(data.error ?? `Request failed (${res.status})`, data.reconnect);
  }
  return res;
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const text = await (await request(path, init)).text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function apiText(path: string): Promise<string> {
  return (await request(path)).text();
}

// For links and EventSource, which can't send headers.
export function authUrl(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(token)}`;
}
