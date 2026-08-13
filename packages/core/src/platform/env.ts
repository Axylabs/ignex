/**
 * Environment & typed config — dotenv loading + typed accessors.
 */
import { existsSync, readFileSync } from "node:fs";
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
