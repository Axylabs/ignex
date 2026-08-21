/**
 * Secret-scan gate: fail CI if a tracked file contains a likely credential.
 *
 * Runs over `git ls-files` (tracked files only — a gitignored `.npmrc` with a
 * live token is exactly the class of leak this prevents from ever being
 * committed). Looks for:
 *
 *   - npm auth tokens (`npm_<base62>` — the class of the 2026-08 .npmrc leak)
 *   - GitHub / generic `ghp_`/`github_pat_` personal access tokens
 *   - AWS access key ids + secret access keys
 *   - private key PEM blocks and obvious "BEGIN ... PRIVATE KEY" material
 *   - common cloud/webhook secrets with known prefixes
 *
 * Usage: `bun scripts/scan-secrets.ts` — exits 1 with a file:line list when
 * anything matches. Intentionally conservative: it scans raw bytes, so
 * legitimate fixtures that merely resemble secrets are flagged for triage
 * (add an explicit allowlist entry below ONLY after confirming the file is a
 * fixture, never for real credentials).
 */
import { execFileSync } from "node:child_process";

/** Matches npm's `npm_` + 36 base62 chars (public/legacy/granular tokens). */
const NPM_TOKEN = /npm_[A-Za-z0-9]{30,}/g;

/** GitHub personal access tokens (classic + fine-grained). */
const GITHUB_TOKEN = /ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,}/g;

/** AWS access key id + (optional, same line) secret key. */
const AWS_KEY = /(AKIA|ASIA)[A-Z0-9]{16}(.*?[A-Za-z0-9/+=]{40})?/g;

/** Private key material — any PEM PRIVATE KEY block. */
const PEM_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----|-----BEGIN OPENSSH PRIVATE KEY-----/g;

/** Common well-known secret prefixes (Stripe, Slack, SendGrid, Twilio, …). */
const KNOWN_PREFIX =
  /\b(sk_live_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|SG\.[A-Za-z0-9_-]{20,}|AC[a-z0-9]{32}|gho_[A-Za-z0-9]{36,})\b/g;

/** Tracked files never to scan (documented fixtures only). */
const ALLOWLIST = new Set<string>([]);

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

const scanFile = (file: string, bytes: Uint8Array): Hit[] => {
  if (ALLOWLIST.has(file)) return [];
  const text = new TextDecoder("utf-8").decode(bytes);
  const patterns = [NPM_TOKEN, GITHUB_TOKEN, AWS_KEY, PEM_KEY, KNOWN_PREFIX];
  const hits: Hit[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (match[0] === undefined) continue;
      const line = text.slice(0, match.index ?? 0).split("\n").length;
      hits.push({ file, line, match: match[0].slice(0, 80) });
    }
  }
  return hits;
};

const main = (): void => {
  const files = execFileSync("git", ["ls-files", "-z"], {
    encoding: "buffer",
  })
    .toString()
    .split("\0")
    .filter(Boolean);

  const all: Hit[] = [];
  for (const file of files) {
    let bytes: Uint8Array;
    try {
      bytes = execFileSync("git", ["show", `:${file}`], {
        encoding: "buffer",
      }) as Uint8Array;
    } catch {
      continue; // not in the index (shouldn't happen for ls-files output)
    }
    all.push(...scanFile(file, bytes));
  }

  if (all.length > 0) {
    console.error("[scan-secrets] BLOCKING — potential credential(s) in tracked files:");
    for (const hit of all) {
      console.error(`  ${hit.file}:${hit.line}  ${hit.match}`);
    }
    console.error(
      "[scan-secrets] If this is a false positive on a fixture, add the file to the " +
        "ALLOWLIST in scripts/scan-secrets.ts — never allowlist real credentials.",
    );
    process.exit(1);
  }
  console.log(`[scan-secrets] OK — no secrets in ${files.length} tracked files.`);
};

main();
