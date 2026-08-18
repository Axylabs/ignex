/**
 * @fileoverview TLS / HTTPS resolution for `Bun.serve`.
 *
 * Ignex serves HTTPS by default: `Bun.serve` needs a `tls` block for TLS, so
 * `resolveServeTls` guarantees one at serve time:
 *
 *   - `server.https: false` → plain HTTP/1, no certificates involved.
 *   - user `server.tls`     → validated and passed through.
 *   - dev + no certs        → generate local certs (mkcert → openssl),
 *                             cached under `certDir`, with a warning that they
 *                             are for local development only.
 *   - prod + no certs       → loud warning + HTTP/1 fallback. TLS is normally
 *                             terminated at the proxy (e.g. Caddy for HTTP/2 /
 *                             HTTP/3) in production; certs are never
 *                             auto-generated.
 *
 * Both the AOT-compiled server (`@ignex/compiler` codegen) and the
 * interpreted `createApp().serve()` path call {@link resolveServeTls} so the
 * two share one policy.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** User-facing TLS configuration (file paths) for the `server` app config. */
export interface ServerTlsConfig {
  /** Path to the PEM server certificate (optionally a chain). */
  certFile?: string;
  /** Path to the PEM private key. */
  keyFile?: string;
  /** Path to a CA bundle to trust (optional). */
  caFile?: string;
  /** Passphrase for an encrypted private key (optional). */
  passphrase?: string;
}

/** The `server` app-config fields consumed by {@link resolveServeTls}. */
export interface ServerProtocolConfig {
  /** Serve HTTPS over TLS. Default `true`; set `false` for plain HTTP/1. */
  https?: boolean;
  /** Explicit TLS cert/key config. Omit in dev to auto-generate local certs. */
  tls?: ServerTlsConfig;
  /** Directory for generated dev certificates (default `.ignex/certs`). */
  certDir?: string;
}

/** Options for {@link resolveServeTls}. */
export interface ResolveTlsOptions {
  /** Production mode: never auto-generate certs; warn loudly. */
  production?: boolean;
  /** Fallback cert dir when `cfg.certDir` is unset (dev only). */
  certDir?: string;
  /** Warning sink; defaults to `console.warn`. */
  log?: (message: string) => void;
}

/** Result of {@link resolveServeTls}, applied to the `Bun.serve` options. */
export interface ResolvedTls {
  /** Pass to `Bun.serve({ tls })`. Absent when serving plain HTTP/1. */
  tls?: Bun.TLSOptions;
  /** Scheme to use in the startup log line. */
  protocol: "http" | "https";
  /** Warnings raised (also forwarded to `log`). */
  warnings: readonly string[];
  /** Directory holding generated dev certs (dev only). */
  certDir?: string;
}

/** How a dev certificate pair was produced. */
export type DevCertKind = "cached" | "mkcert" | "openssl";

/** A generated dev certificate pair on disk. */
export interface DevCert {
  /** Absolute path to the PEM certificate. */
  certFile: string;
  /** Absolute path to the PEM private key. */
  keyFile: string;
  /** How the pair was produced. */
  kind: DevCertKind;
}

/** File names used for generated dev certificates inside `certDir`. */
export const DEV_CERT_FILENAMES = { cert: "cert.pem", key: "key.pem" } as const;

/** Default directory for generated dev certificates (cwd-relative). */
export const defaultCertDir = (): string => join(process.cwd(), ".ignex", "certs");

/** Run a command synchronously; returns `true` when it exits 0. */
const run = (cmd: string[], log: (m: string) => void): boolean => {
  try {
    const res = Bun.spawnSync(cmd, { stdout: "ignore", stderr: "pipe" });
    if (res.exitCode !== 0) {
      const stderr = res.stderr.toString().trim();
      log(`[ignex] ${cmd[0]} failed (exit ${res.exitCode})${stderr ? `: ${stderr}` : ""}`);
      return false;
    }
    return true;
  } catch (err) {
    log(`[ignex] could not run ${cmd[0]}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
};

/**
 * Ensure a local dev certificate pair exists under `certDir`, generating it
 * on first use (mkcert → openssl) and reusing it afterwards.
 *
 * Returns `null` when neither tool is available or generation fails — the
 * caller should fall back to HTTP/1.
 */
export const ensureDevCerts = (
  certDir: string,
  log: (m: string) => void = console.warn,
): DevCert | null => {
  const certFile = join(certDir, DEV_CERT_FILENAMES.cert);
  const keyFile = join(certDir, DEV_CERT_FILENAMES.key);

  try {
    mkdirSync(certDir, { recursive: true });
  } catch (err) {
    log(
      `[ignex] could not create cert dir ${certDir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  if (existsSync(certFile) && existsSync(keyFile)) {
    return { certFile, keyFile, kind: "cached" };
  }

  // mkcert: installs a locally-trusted CA so browsers accept `https://localhost`
  // with no security prompt.
  if (Bun.which("mkcert")) {
    const ok =
      run(["mkcert", "-install"], log) &&
      run(
        ["mkcert", "-key-file", keyFile, "-cert-file", certFile, "localhost", "127.0.0.1", "::1"],
        log,
      ) &&
      existsSync(certFile) &&
      existsSync(keyFile);
    if (ok) return { certFile, keyFile, kind: "mkcert" };
  }

  // openssl: self-signed fallback — works anywhere openssl exists, but
  // browsers warn until the cert is manually trusted.
  if (Bun.which("openssl")) {
    const ok =
      run(
        [
          "openssl",
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          keyFile,
          "-out",
          certFile,
          "-days",
          "365",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1",
        ],
        log,
      ) &&
      existsSync(certFile) &&
      existsSync(keyFile);
    if (ok) return { certFile, keyFile, kind: "openssl" };
  }

  return null;
};

/** Build a `Bun.TLSOptions` object from a cert/key path pair + optional config. */
const buildTls = (certFile: string, keyFile: string, cfg?: ServerTlsConfig): Bun.TLSOptions => {
  const tls: Bun.TLSOptions = { cert: Bun.file(certFile), key: Bun.file(keyFile) };
  const caFile = cfg?.caFile;
  const passphrase = cfg?.passphrase;
  if (caFile && existsSync(caFile)) tls.ca = Bun.file(caFile);
  if (passphrase) tls.passphrase = passphrase;
  return tls;
};

/** Values of `IGNEX_HTTPS` that force plain HTTP/1. */
const IGNEX_HTTPS_OFF = new Set(["0", "false", "off", "no"]);

/** Resolve the effective HTTPS preference (config → `IGNEX_HTTPS` env). */
const preferHttps = (cfg: ServerProtocolConfig): boolean => {
  const env = process.env.IGNEX_HTTPS;
  if (env !== undefined) {
    return !IGNEX_HTTPS_OFF.has(env.trim().toLowerCase());
  }
  return cfg.https ?? true;
};

/**
 * Resolve the TLS configuration for `Bun.serve` from the `server` app-config
 * (or interpreted serve options), implementing the HTTPS-by-default policy:
 *
 * - `https: false` (or `IGNEX_HTTPS=0|false|off|no`) → no TLS (plain HTTP/1).
 * - explicit `tls` → used when the referenced files exist.
 * - otherwise, dev generates local certs; production warns + falls back to
 *   HTTP/1.
 */
export const resolveServeTls = (
  cfg: ServerProtocolConfig = {},
  opts: ResolveTlsOptions = {},
): ResolvedTls => {
  const https = preferHttps(cfg);
  const log = opts.log ?? console.warn;
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    log(message);
  };

  // Explicit HTTP/1 — no TLS resolution needed.
  if (!https) return { protocol: "http", warnings };

  // 1) User-provided certs.
  if (cfg.tls) {
    const { certFile, keyFile } = cfg.tls;
    if (certFile && keyFile && existsSync(certFile) && existsSync(keyFile)) {
      return {
        tls: buildTls(certFile, keyFile, cfg.tls),
        protocol: "https",
        warnings,
      };
    }
    const missing = [certFile, keyFile].filter((p) => p && !existsSync(p)).join(", ");
    warn(
      `[ignex] server.tls configured but ${missing || "certificate files"} not found — falling back to ${
        opts.production ? "HTTP/1 (production)" : "a local dev certificate"
      }.`,
    );
  }

  // 2) Development: generate + cache a local certificate.
  if (!opts.production) {
    const dir = cfg.certDir ?? opts.certDir ?? defaultCertDir();
    const dev = ensureDevCerts(dir, log);
    if (dev) {
      if (dev.kind === "mkcert") {
        warn(`[ignex] HTTPS enabled with a locally-trusted dev certificate (mkcert) from ${dir}.`);
      } else if (dev.kind === "openssl") {
        warn(
          `[ignex] HTTPS enabled with a SELF-SIGNED dev certificate at ${dir} — accept the security prompt in your browser (localhost). Local development only; set server.tls { certFile, keyFile } for real certs.`,
        );
      } else {
        warn(`[ignex] HTTPS enabled with a cached dev certificate at ${dir}.`);
      }
      return {
        tls: buildTls(dev.certFile, dev.keyFile),
        protocol: "https",
        warnings,
        certDir: dir,
      };
    }
    warn(
      `[ignex] could not generate a local certificate (neither mkcert nor openssl is available) — falling back to HTTP/1. Install mkcert or openssl, or set server.tls { certFile, keyFile }.`,
    );
    return { protocol: "http", warnings, certDir: dir };
  }

  // 3) Production without certs — never auto-generate; fall back to HTTP/1.
  warn(
    `[ignex] HTTPS requested but no TLS certificates are configured (server.tls). Falling back to HTTP/1. Terminate TLS at your proxy (nginx/Caddy/Cloudflare) or set server.tls { certFile, keyFile }; set server.https = false to silence this warning.`,
  );
  return { protocol: "http", warnings };
};
