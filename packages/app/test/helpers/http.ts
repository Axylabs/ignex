/**
 * @fileoverview Minimal typed HTTP client for integration suites.
 *
 * A thin wrapper over `fetch` bound to a booted server's base URL so
 * request-matrix tests stay declarative and consistent:
 *
 * ```ts
 * const client = createClient(srv.base);
 * const res = await client.post("/json", JSON.stringify({ a: 1 }), {
 *   headers: { "content-type": "application/json" },
 * });
 * expect(res.status).toBe(200);
 * expect(await jsonBody(res)).toEqual({ ok: true });
 * ```
 */

export type TestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export interface TestClient {
  readonly base: string;
  request(method: TestMethod, path: string, init?: RequestInit): Promise<Response>;
  get(path: string, init?: RequestInit): Promise<Response>;
  post(path: string, body?: BodyInit | null, init?: RequestInit): Promise<Response>;
  put(path: string, body?: BodyInit | null, init?: RequestInit): Promise<Response>;
  patch(path: string, body?: BodyInit | null, init?: RequestInit): Promise<Response>;
  del(path: string, init?: RequestInit): Promise<Response>;
  head(path: string, init?: RequestInit): Promise<Response>;
  options(path: string, init?: RequestInit): Promise<Response>;
}

export const createClient = (base: string): TestClient => {
  const request = (method: TestMethod, path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${path}`, { ...init, method });

  const withBody =
    (method: "POST" | "PUT" | "PATCH") =>
    (path: string, body?: BodyInit | null, init: RequestInit = {}): Promise<Response> =>
      request(method, path, body === undefined ? init : { ...init, body });

  return {
    base,
    request,
    get: (path, init) => request("GET", path, init),
    post: withBody("POST"),
    put: withBody("PUT"),
    patch: withBody("PATCH"),
    del: (path, init) => request("DELETE", path, init),
    head: (path, init) => request("HEAD", path, init),
    options: (path, init) => request("OPTIONS", path, init),
  };
};

/**
 * Parse a response body as JSON, throwing a descriptive error when the body
 * is not JSON (surfaces the raw body to make integration failures debuggable).
 */
export const jsonBody = async (res: Response): Promise<unknown> => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`expected a JSON body, got: ${JSON.stringify(text.slice(0, 200))}`);
  }
};
