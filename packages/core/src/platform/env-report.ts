/**
 * @fileoverview Dotenv introspection for boot reports — which `.env` files sit
 * next to the process, and which connection variables they define.
 *
 * Split out of `boot-failure.ts` so the report's two concerns stay separate:
 * this module reads the configuration state (pure I/O, never throws), while
 * `boot-failure.ts` classifies the throw and renders the report.
 *
 * Values are only returned for connection-shaped variables (`scheme://…`) and
 * are always credential-masked: a boot report gets pasted into issues, so a
 * password must never reach it.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clipLine, maskCredentials } from "./redact";

/** A connection-shaped variable found in a dotenv file (value masked). */
export interface EnvConnectionVar {
  /** Variable name (`MONGO_URL`). */
  readonly key: string;
  /** Credential-masked, clipped value. */
  readonly display: string;
  /** Dotenv file the value came from (relative to {@link EnvFileReport.cwd}). */
  readonly file: string;
}

/** The dotenv state a boot report describes. */
export interface EnvFileReport {
  /** Directory the dotenv files were resolved against. */
  readonly cwd: string;
  /** Candidate files that were checked, whether or not they exist. */
  readonly candidates: readonly string[];
  /** Candidate files that exist, in load order. */
  readonly present: readonly string[];
  /** Example files that exist (`.env.example`, …) — copy sources for `.env`. */
  readonly examples: readonly string[];
  /** Connection-shaped variables found in {@link present} (first wins). */
  readonly variables: readonly EnvConnectionVar[];
}

/** Dotenv files an ignex app loads (the defaults of `loadEnv`). */
const ENV_CANDIDATES = [".env", ".env.local"] as const;

/** Example files offered as a copy source when `.env` is missing or stale. */
const ENV_EXAMPLE_CANDIDATES = [".env.example", ".env.sample", ".env.template"] as const;

/** Only values that look like a connection string are ever reported. */
const CONNECTION_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Keep a rendered connection URL short enough to read on one line. */
const MAX_URL = 96;

/** Never list more connection variables than this. */
const MAX_VARS = 6;

/** `KEY=value` pairs of dotenv text (comments, `export `, quotes handled). */
const dotenvEntries = (text: string): ReadonlyArray<readonly [string, string]> => {
  const entries: Array<readonly [string, string]> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    const key = match?.[1];
    if (match === null || key === undefined) continue;
    let value = (match[2] ?? "").trim();
    const quote = value[0];
    if (value.length > 1 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    entries.push([key, value]);
  }
  return entries;
};

/** Read a file, returning `""` when it cannot be read (a report must not throw). */
const safeRead = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

/** Clip a display value to one line of at most `MAX_URL` characters. */
const clipDisplay = (value: string): string => clipLine(value, MAX_URL);

/**
 * Read the dotenv state next to the process: which files exist, which examples
 * could be copied, and which connection-shaped variables they define (values
 * credential-masked and clipped). Never throws.
 *
 * @param cwd - Directory the candidate files are resolved against.
 * @returns The `.env` state for a boot report.
 */
export const readEnvFileReport = (cwd: string): EnvFileReport => {
  const present: string[] = [];
  const variables: EnvConnectionVar[] = [];

  for (const candidate of ENV_CANDIDATES) {
    if (!existsSync(resolve(cwd, candidate))) continue;
    present.push(candidate);
    for (const [key, value] of dotenvEntries(safeRead(resolve(cwd, candidate)))) {
      if (variables.length >= MAX_VARS) break;
      if (!CONNECTION_URL.test(value)) continue;
      if (variables.some((variable) => variable.key === key)) continue;
      variables.push({ key, display: clipDisplay(maskCredentials(value)), file: candidate });
    }
  }

  return {
    cwd,
    candidates: [...ENV_CANDIDATES],
    present,
    examples: ENV_EXAMPLE_CANDIDATES.filter((candidate) => existsSync(resolve(cwd, candidate))),
    variables,
  };
};
