import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolve the Rust cdylib path for the CURRENT platform/arch.
 *
 * Previously hardcoded to `rust/target/release/libignex_ffi.so` (Linux-only).
 * Now maps `process.platform` → the correct library name (.so / .dylib / .dll)
 * and searches, in order:
 *   1. `IGNEX_FFI_PATH` env override (absolute path to the addon)
 *   2. the in-repo dev build:  `<repo>/rust/target/release/<lib>`
 *   3. the packaged npm layout: `<pkg>/prebuilds/<platform>-<arch>/<lib>`
 *
 * Bun is the only supported runtime; the addon must be built per-OS (see
 * README). A clear error listing every candidate is thrown when missing.
 */
const LIB_NAMES: Record<string, string> = {
  linux: "libignex_ffi.so",
  darwin: "libignex_ffi.dylib",
  win32: "ignex_ffi.dll",
};

/** The cdylib filename for a platform (used for tests + build tooling). */
export function addonFilename(platform: string = process.platform): string {
  const name = LIB_NAMES[platform];
  if (!name) throw new Error(`ignex: unsupported platform "${platform}"`);
  return name;
}

const here = import.meta.dir;

/** Candidate addon paths in priority order (first existing wins). */
export function addonCandidates(): string[] {
  const file = addonFilename();
  const tag = `${process.platform}-${process.arch}`;
  return [
    // in-repo dev build (repo root = src/native/../../)
    join(here, "..", "..", "rust", "target", "release", file),
    // packaged npm layout: <pkg-root>/prebuilds/<platform>-<arch>/<lib>
    join(here, "..", "prebuilds", tag, file),
    join(here, "..", "..", "prebuilds", tag, file),
  ];
}

export function getAddonPath(): string {
  const override = process.env.IGNEX_FFI_PATH;
  if (override) return override;
  for (const p of addonCandidates()) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `ignex: native addon not found. Tried:\n  ${addonCandidates().join("\n  ")}\n` +
      `Build it: cargo build --release --manifest-path rust/Cargo.toml  (or set IGNEX_FFI_PATH)`,
  );
}
