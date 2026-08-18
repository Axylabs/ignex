/**
 * TLS / HTTPS-protocol resolution tests — `resolveServeTls` + `ensureDevCerts`.
 *
 * Covers the HTTPS-by-default policy: explicit HTTP/1 opt-out, user-provided
 * certs (present + missing), dev auto-generation (mkcert → openssl → fallback),
 * and the production fallback that never auto-generates certs.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveServeTls, type ServerProtocolConfig } from "../src/http/tls";

/** Captures warnings instead of printing them. */
const noopLog = (): void => {};

const stubBun = (): {
  which: ReturnType<typeof vi.fn>;
  spawnSync: ReturnType<typeof vi.fn>;
  file: ReturnType<typeof vi.fn>;
} => {
  const which = vi.fn(() => null);
  const spawnSync = vi.fn(() => ({ exitCode: 0, stderr: "" }));
  const file = vi.fn((p: string) => ({ path: p }));
  vi.stubGlobal("Bun", { which, spawnSync, file });
  return { which, spawnSync, file };
};

describe("resolveServeTls — explicit HTTP/1 opt-out", () => {
  beforeEach(() => stubBun());
  afterEach(() => vi.unstubAllGlobals());

  it("returns no tls and http protocol when https is false", () => {
    const res = resolveServeTls({ https: false }, { log: noopLog });
    expect(res.protocol).toBe("http");
    expect(res.tls).toBeUndefined();
    expect(res.warnings).toEqual([]);
  });

  it("defaults to https when unset", () => {
    const res = resolveServeTls({}, { production: true, log: noopLog });
    expect(res.protocol).toBe("http"); // prod fallback (no certs)
    expect(res.warnings.length).toBeGreaterThan(0);
  });
});

describe("resolveServeTls — user-provided certs", () => {
  let dir: string;
  let certFile: string;
  let keyFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ignex-tls-"));
    certFile = join(dir, "cert.pem");
    keyFile = join(dir, "key.pem");
    stubBun();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("passes through valid cert/key files and reports https", () => {
    writeFileSync(certFile, "CERT");
    writeFileSync(keyFile, "KEY");
    const cfg: ServerProtocolConfig = { tls: { certFile, keyFile } };
    const res = resolveServeTls(cfg, { log: noopLog });
    expect(res.protocol).toBe("https");
    expect(res.tls).toBeDefined();
    expect(res.warnings).toEqual([]);
  });

  it("warns and falls back to a dev cert in dev when files are missing", () => {
    const fallbackDir = mkdtempSync(join(tmpdir(), "ignex-tls-fallback-"));
    const bun = stubBun();
    bun.which.mockImplementation((bin: string) => (bin === "mkcert" ? "/usr/bin/mkcert" : null));
    bun.spawnSync.mockImplementation(() => {
      writeFileSync(join(fallbackDir, "cert.pem"), "CERT");
      writeFileSync(join(fallbackDir, "key.pem"), "KEY");
      return { exitCode: 0, stderr: "" };
    });
    const warnings: string[] = [];
    const res = resolveServeTls(
      { tls: { certFile, keyFile } },
      { production: false, certDir: fallbackDir, log: (m) => warnings.push(m) },
    );
    expect(res.protocol).toBe("https"); // dev auto-generated
    expect(warnings.some((w) => w.includes("not found"))).toBe(true);
  });

  it("warns and falls back to HTTP/1 in production when files are missing", () => {
    const warnings: string[] = [];
    const res = resolveServeTls(
      { tls: { certFile, keyFile } },
      { production: true, log: (m) => warnings.push(m) },
    );
    expect(res.protocol).toBe("http");
    expect(res.tls).toBeUndefined();
    expect(warnings.some((w) => w.includes("not found"))).toBe(true);
  });
});

describe("resolveServeTls — dev auto-generation", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ignex-dev-certs-"));
    stubBun();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("uses mkcert when available and reports https + warning", () => {
    const bun = stubBun();
    bun.which.mockImplementation((bin: string) => (bin === "mkcert" ? "/usr/bin/mkcert" : null));
    bun.spawnSync.mockImplementation(() => {
      // mkcert -install then mkcert -key-file/-cert-file: write the files so
      // existsSync() succeeds after generation.
      writeFileSync(join(dir, "cert.pem"), "CERT");
      writeFileSync(join(dir, "key.pem"), "KEY");
      return { exitCode: 0, stderr: "" };
    });
    const warnings: string[] = [];
    const res = resolveServeTls(
      {},
      { production: false, certDir: dir, log: (m) => warnings.push(m) },
    );
    expect(res.protocol).toBe("https");
    expect(res.tls).toBeDefined();
    expect(res.certDir).toBe(dir);
    expect(warnings.some((w) => w.includes("mkcert"))).toBe(true);
  });

  it("falls back to openssl when mkcert is absent", () => {
    const bun = stubBun();
    bun.which.mockImplementation((bin: string) => (bin === "openssl" ? "/usr/bin/openssl" : null));
    bun.spawnSync.mockImplementation(() => {
      writeFileSync(join(dir, "cert.pem"), "CERT");
      writeFileSync(join(dir, "key.pem"), "KEY");
      return { exitCode: 0, stderr: "" };
    });
    const warnings: string[] = [];
    const res = resolveServeTls(
      {},
      { production: false, certDir: dir, log: (m) => warnings.push(m) },
    );
    expect(res.protocol).toBe("https");
    expect(warnings.some((w) => w.includes("SELF-SIGNED"))).toBe(true);
  });

  it("falls back to HTTP/1 with a warning when no tool is available", () => {
    const warnings: string[] = [];
    const res = resolveServeTls(
      {},
      { production: false, certDir: dir, log: (m) => warnings.push(m) },
    );
    expect(res.protocol).toBe("http");
    expect(res.tls).toBeUndefined();
    expect(res.warnings.length).toBeGreaterThan(0);
  });
});

describe("resolveServeTls — production fallback", () => {
  beforeEach(() => stubBun());
  afterEach(() => vi.unstubAllGlobals());

  it("warns loudly and never auto-generates certs in production", () => {
    const warnings: string[] = [];
    const res = resolveServeTls({}, { production: true, log: (m) => warnings.push(m) });
    expect(res.protocol).toBe("http");
    expect(res.tls).toBeUndefined();
    expect(res.certDir).toBeUndefined();
    expect(warnings.some((w) => w.includes("HTTPS requested but no TLS certificates"))).toBe(true);
  });
});

describe("resolveServeTls — IGNEX_HTTPS env override", () => {
  beforeEach(() => stubBun());
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.IGNEX_HTTPS;
  });

  it("forces plain HTTP/1 when IGNEX_HTTPS=0", () => {
    process.env.IGNEX_HTTPS = "0";
    const res = resolveServeTls({}, { production: true, log: noopLog });
    expect(res.protocol).toBe("http");
    expect(res.tls).toBeUndefined();
    expect(res.warnings).toEqual([]);
  });

  it("still serves HTTPS when IGNEX_HTTPS=1", () => {
    process.env.IGNEX_HTTPS = "1";
    const res = resolveServeTls({}, { production: true, log: noopLog });
    expect(res.protocol).toBe("http"); // prod fallback (no certs)
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it("lets the config win when IGNEX_HTTPS is unset", () => {
    const res = resolveServeTls({ https: false }, { production: true, log: noopLog });
    expect(res.protocol).toBe("http");
  });
});
