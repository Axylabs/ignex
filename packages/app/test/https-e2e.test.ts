/**
 * @fileoverview HTTPS end-to-end: the matrix fixture booted over TLS.
 *
 * The compiled server is HTTPS-by-default in dev (`resolveServeTls` → local
 * dev certificate, cached under the fixture's `dist/certs`). This suite boots
 * with `IGNEX_HTTPS=1` (env wins over the fixture's `https: false`, which
 * exists so the plain-HTTP suites skip TLS) and drives a liveness probe plus
 * one data route over a real TLS connection with the self-signed cert
 * accepted. TLS verification is disabled INSIDE this file only (restored in
 * `afterAll`) — the shared boot harness already needs the same override for
 * its health poll.
 *
 * Skipped (with cause) on hosts with neither mkcert nor openssl — the two
 * provisioning paths `ensureDevCerts` supports; without one there is no dev
 * certificate and the server falls back to HTTP/1.
 */
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BootedServer, bootServer, MATRIX_FIXTURE } from "./helpers/boot";
import { createClient, jsonBody, type TestClient } from "./helpers/http";

/** Can the server provision a dev certificate? (mkcert → openssl fallback.) */
const canProvisionCert = (cmd: string, args: string[]): boolean => {
  try {
    return spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
};

const CERT_TOOL_AVAILABLE =
  canProvisionCert("mkcert", ["-help"]) || canProvisionCert("openssl", ["version"]);

/** TLS acceptance is scoped to this file (restored in afterAll). */
const previousTlsEnv = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

let srv: BootedServer;
let client: TestClient;

beforeAll(async () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  srv = await bootServer(MATRIX_FIXTURE, {
    protocol: "https",
    // The fixture pins `server.https: false` for the plain-HTTP suites; the
    // env override re-enables the HTTPS-by-default policy for this boot.
    env: { IGNEX_HTTPS: "1" },
  });
  client = createClient(srv.base);
}, 60_000);

afterAll(() => {
  srv.close();
  if (previousTlsEnv === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsEnv;
});

describe.runIf(CERT_TOOL_AVAILABLE)("HTTPS e2e (compiled server over TLS)", () => {
  it("serves /health over https with a 200 + JSON body", async () => {
    expect(srv.base.startsWith("https://")).toBe(true);
    const res = await client.get("/health");
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ status: "ok" });
  });

  it("serves a data route over https (param echo)", async () => {
    const res = await client.get("/users/42");
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ id: "42" });
  });
});
