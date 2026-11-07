/**
 * @fileoverview CSRF double-submit journeys (compiled server).
 *
 * The fixture's `/csrf` + `/csrf-submit` routes share one `createCsrfGuard`
 * instance (`createCsrfGuard` now enforces Origin by default). The journey
 * mirrors a browser form flow: GET through the guard mints the `csrf-token`
 * cookie; POSTs must echo it in `x-csrf-token`. Covered:
 *
 *  - cookie minting on GET;
 *  - POST without the header → 403 `CSRF token validation failed`;
 *  - POST with cookie + header → 200 echo;
 *  - cross-site `Origin` → 403 `CSRF origin validation failed` even with a
 *    valid token pair;
 *  - same-origin `Origin` → 200 (header-less curl-like clients skip the
 *    origin layer entirely — the smoke script covers that path).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BootedServer, bootServer, MATRIX_FIXTURE } from "./helpers/boot";
import { createClient, jsonBody, type TestClient } from "./helpers/http";

let srv: BootedServer;
let client: TestClient;

beforeAll(async () => {
  srv = await bootServer(MATRIX_FIXTURE);
  client = createClient(srv.base);
});

afterAll(() => srv.close());

/**
 * Extract the `csrf-token` cookie value from a response. The fixture also
 * runs the session plugin (a `sid` cookie), so the set-cookie header set has
 * more than one entry — `getSetCookie()` is the only lossless reader.
 */
const mintCsrfToken = async (): Promise<string> => {
  const mint = await client.get("/csrf");
  expect(mint.status).toBe(200);
  expect(await jsonBody(mint)).toEqual({ csrf: "ready" });

  const jars =
    typeof mint.headers.getSetCookie === "function"
      ? mint.headers.getSetCookie()
      : [mint.headers.get("set-cookie") ?? ""];
  for (const jar of jars) {
    const pair = jar.split(";")[0] ?? "";
    if (pair.startsWith("csrf-token=")) return pair.slice("csrf-token=".length);
  }
  throw new Error(`no csrf-token cookie minted (set-cookie: ${jars.join(" | ")})`);
};

/** POST /csrf-submit with the given headers, returning the raw response. */
const submit = (headers: Record<string, string>): Promise<Response> =>
  client.post("/csrf-submit", JSON.stringify({ item: "widget" }), {
    headers: { "content-type": "application/json", ...headers },
  });

describe("CSRF journeys (compiled server)", () => {
  it("mints a csrf-token cookie on GET through the guard", async () => {
    const token = await mintCsrfToken();
    expect(token.length).toBeGreaterThan(16);
  });

  it("rejects a POST without the x-csrf-token header (403)", async () => {
    const token = await mintCsrfToken();

    const bare = await submit({});
    expect(bare.status).toBe(403);
    expect(await jsonBody(bare)).toEqual({ error: "CSRF token validation failed" });

    // Cookie without the header is still an invalid double-submit pair.
    const cookieOnly = await submit({ cookie: `csrf-token=${token}` });
    expect(cookieOnly.status).toBe(403);
    expect(await jsonBody(cookieOnly)).toEqual({ error: "CSRF token validation failed" });
  });

  it("accepts a POST with the cookie + header pair (200 echo)", async () => {
    const token = await mintCsrfToken();
    const res = await submit({
      cookie: `csrf-token=${token}`,
      "x-csrf-token": token,
    });
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ echoed: { item: "widget" } });
  });

  it("rejects a cross-origin Origin header even with a valid token pair (403)", async () => {
    const token = await mintCsrfToken();
    const res = await submit({
      cookie: `csrf-token=${token}`,
      "x-csrf-token": token,
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({ error: "CSRF origin validation failed" });
  });

  it("accepts a same-origin Origin header with a valid token pair (200)", async () => {
    const token = await mintCsrfToken();
    const res = await submit({
      cookie: `csrf-token=${token}`,
      "x-csrf-token": token,
      origin: srv.base,
    });
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ echoed: { item: "widget" } });
  });
});
