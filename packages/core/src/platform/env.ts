/**
 * Environment & typed config — dotenv loading + typed accessors.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tryCatchOr } from "@ignex/shared";
import { coerceBoolean } from "./coerce";

/** Parse a dotenv-style line into `[key, value]` (or `null`). */
const parseLine = (line: string): [string, string] | null => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const eq = trimmed.indexOf("=");
  if (eq < 0) return null;

  let key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();

  if (key.startsWith("export ")) key = key.slice(7).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return [key, value];
};

/**
 * Load `.env` files into `process.env` (existing variables win — files never
 * override the actual environment). Safe to call multiple times.
 */
export const loadEnv = (paths: string[] = [".env", ".env.local"]): void => {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const parsed = parseLine(line);
      if (parsed && process.env[parsed[0]] === undefined) {
        process.env[parsed[0]] = parsed[1];
      }
    }
  }
};

/**
 * Idempotently write `keys` into a dotenv file (default `.env`).
 *
 * Existing variables win: a key already present in the file OR in
 * `process.env` is never overwritten. New keys are appended (one per line) and
 * reflected into `process.env` so the running process picks them up
 * immediately. Used by the auth module's key bootstrap (Ed25519 keypair into
 * `.env`).
 *
 * @returns The number of keys appended (0 = nothing to write).
 */
export const writeEnvKeys = (keys: Record<string, string>, path = ".env"): number => {
  const fileKeys = new Set<string>();
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const parsed = parseLine(line);
      if (parsed) fileKeys.add(parsed[0]);
    }
  }

  const pending: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(keys)) {
    // Never override an existing .env entry or an actual environment variable.
    if (fileKeys.has(key) || process.env[key] !== undefined) continue;
    pending.push([key, value]);
    process.env[key] = value;
  }
  if (pending.length === 0) return 0;

  const block = pending.map(([key, value]) => `${key}=${value}`).join("\n");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const sep = existing === "" || existing.endsWith("\n") ? "" : "\n";
  // Secrets may land here (auth key bootstrap writes Ed25519 private keys),
  // so the file is owner-read/write only — and an existing file with looser
  // perms is tightened rather than left world-readable.
  writeFileSync(path, `${existing}${sep}${block}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on platforms without POSIX perms.
  }
  return pending.length;
};

const get = (key: string, fallback?: string): string | undefined => {
  const value = process.env[key];
  return value !== undefined ? value : fallback;
};

/** Read a string env var, falling back when absent. */
export function env(key: string, fallback: string): string;
export function env(key: string, fallback?: string): string | undefined;
export function env(key: string, fallback?: string): string | undefined {
  return get(key, fallback);
}

/**
 * Read a typed env var: coerce the raw value, falling back when unset or when
 * coercion throws. Shared by the typed accessors below.
 */
const readEnv = <T>(key: string, coerce: (raw: string) => T, fallback: T): T => {
  const raw = get(key);
  if (raw === undefined) return fallback;
  return tryCatchOr(fallback, () => coerce(raw));
};

/** Read an integer env var. */
export const envInt = (key: string, fallback = 0): number =>
  readEnv(
    key,
    (raw) => {
      const parsed = Number.parseInt(raw, 10);
      return Number.isNaN(parsed) ? fallback : parsed;
    },
    fallback,
  );

/** Read a float env var. */
export const envFloat = (key: string, fallback = 0): number =>
  readEnv(
    key,
    (raw) => {
      const parsed = Number.parseFloat(raw);
      return Number.isNaN(parsed) ? fallback : parsed;
    },
    fallback,
  );

/** Read a boolean env var (`true/false/1/0/yes/no`). */
export const envBool = (key: string, fallback = false): boolean =>
  readEnv(key, (raw) => coerceBoolean(raw) ?? fallback, fallback);

/** Read + parse a JSON env var. */
export const envJson = <T>(key: string, fallback?: T): T =>
  readEnv<T>(key, (raw) => JSON.parse(raw) as T, fallback as T);

/** Read a secret (same as `env`, named for intent — never logged). */
export const envSecret = (key: string, fallback?: string): string | undefined => env(key, fallback);
