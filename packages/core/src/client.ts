/**
 * Typed HTTP client — the runtime used by compiler-generated client bindings.
 *
 * `createClient` builds a small fetch wrapper around a base URL. The compiler
 * emits typed per-route functions on top of this base.
 */
export interface ClientOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  /** Custom fetch (defaults to the global fetch). */
  fetch?: typeof fetch;
  /** Attach credentials (`credentials: "include"` for cookies). */
  credentials?: RequestCredentials;
}

export interface ClientResponse<T> {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  body: T | null;
}

export interface IgnusClient {
  readonly baseUrl: string;
  /** Perform a JSON request and return the parsed body (throws on non-2xx). */
  request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T>;
  /** Perform a raw request. */
  raw<T = unknown>(path: string, init?: RequestInit): Promise<ClientResponse<T>>;
  get<T>(path: string, init?: RequestInit): Promise<T>;
  post<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
  put<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
  patch<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
  delete<T>(path: string, init?: RequestInit): Promise<T>;
}

export const createClient = (options: ClientOptions): IgnusClient => {
  const base = options.baseUrl.replace(/\/+$/, "");
  const baseHeaders = options.headers ?? {};
  const fetcher = options.fetch ?? globalThis.fetch;
  const credentials = options.credentials;

  const raw = async <T = unknown>(
    path: string,
    init: RequestInit = {},
  ): Promise<ClientResponse<T>> => {
    const response = await fetcher(`${base}${path}`, {
      ...(credentials !== undefined ? { credentials } : {}),
      ...init,
      headers: { ...baseHeaders, ...(init.headers as Record<string, string> | undefined) },
    });

    const text = await response.text();
    let body: T | null = null;
    if (text) {
      try {
        body = JSON.parse(text) as T;
      } catch {
        body = text as unknown as T;
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body,
    };
  };

  const request = async <T>(
    method: string,
    path: string,
    body?: unknown,
    init: RequestInit = {},
  ): Promise<T> => {
    const isBody = body !== undefined;
    const response = await raw<T>(path, {
      ...init,
      method,
      ...(isBody ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
      ...(isBody && typeof body !== "string"
        ? {
            headers: {
              "content-type": "application/json",
              ...(init.headers as Record<string, string> | undefined),
            },
          }
        : {}),
    });

    if (!response.ok) {
      const error = new Error(
        `Request failed: ${response.status} ${response.statusText} ${path}`,
      ) as Error & {
        status: number;
        body: T | null;
      };
      error.status = response.status;
      error.body = response.body;
      throw error;
    }

    return response.body as T;
  };

  return {
    baseUrl: base,
    request,
    raw,
    get: <T>(path: string, init?: RequestInit) => request<T>("GET", path, undefined, init),
    post: <T>(path: string, body?: unknown, init?: RequestInit) =>
      request<T>("POST", path, body, init),
    put: <T>(path: string, body?: unknown, init?: RequestInit) =>
      request<T>("PUT", path, body, init),
    patch: <T>(path: string, body?: unknown, init?: RequestInit) =>
      request<T>("PATCH", path, body, init),
    delete: <T>(path: string, init?: RequestInit) => request<T>("DELETE", path, undefined, init),
  };
};
