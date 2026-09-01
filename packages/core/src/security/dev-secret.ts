/**
 * @fileoverview Stable per-machine development secret for local scaffolds.
 *
 * Scaffolds used to fall back to a well-known literal (`dev-secret-change-me`)
 * when `SESSION_SECRET` was unset. That default is forgeable by anyone who has
 * read the docs, and the session manager now refuses it outside explicit local
 * development — so local apps need a secret that is (a) strong, (b) stable
 * across restarts (stateless signed cookies would otherwise be invalidated on
 * every reboot), and (c) zero-config.
 *
 * `devSessionSecret()` generates a 64-hex-char random secret ONCE, persists it
 * to `.ignex/dev-session-secret` with mode 0600, and reuses it from then on.
 * It is for LOCAL DEVELOPMENT ONLY — production must set a real `SESSION_SECRET`
 * (the strict guard in `createSessionManager` enforces this).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomToken } from "@ignex/native";

/** Minimum accepted length — keep in sync with createSessionManager's floor. */
const MIN_LENGTH = 32;

let cached: string | null = null;

/**
 * Get (or lazily create) the stable local-development session secret.
 *
 * Resolution order: process cache → `.ignex/dev-session-secret` file →
 * freshly generated token (persisted when the filesystem allows).
 *
 * When the file cannot be written (read-only FS), a per-process random secret
 * is used and a warning is printed: sessions reset on every restart instead of
 * ever running on a known constant.
 */
export const devSessionSecret = (): string => {
  if (cached) return cached;

  const dir = join(process.cwd(), ".ignex");
  const file = join(dir, "dev-session-secret");

  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= MIN_LENGTH) {
      cached = existing;
      return cached;
    }
  } catch {
    /* first boot or unreadable — generate below */
  }

  const generated = randomToken(MIN_LENGTH);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${generated}\n`, { mode: 0o600, flag: "w" });
  } catch {
    console.warn(
      "[ignex] could not persist .ignex/dev-session-secret — using a per-process " +
        "random dev secret (sessions reset on restart). Set SESSION_SECRET to silence.",
    );
  }
  cached = generated;
  return cached;
};
