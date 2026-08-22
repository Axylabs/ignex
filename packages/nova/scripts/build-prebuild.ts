/**
 * Build the Rust cdylib and stage it into `prebuilds/<platform>-<arch>/` so
 * the packaged npm layout serves a working addon out of the box (this is the
 * loader's packaged-layout fallback — see src/native/loader.ts).
 *
 * Wired as `prepack`, so both `bun pm pack` and `bun publish` stage the addon
 * for the CURRENT platform automatically. To ship more platforms, run this on
 * each OS and merge the results (see .github/workflows/publish.yml for a
 * matrix that publishes ubuntu/macos/windows prebuilds in one release).
 *
 * Consumers on a platform without a prebuild can still use the package:
 *   - `IGNEX_FFI_PATH=/abs/path/to/libignex_ffi.so bun run ...`
 *   - or rebuild from the shipped rust/ source:
 *     `cargo build --release --manifest-path node_modules/ignex-nova/rust/Cargo.toml`
 */
import { execSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { addonFilename } from "../src/native/loader";

const root = join(import.meta.dir, "..");
const tag = `${process.platform}-${process.arch}`;

console.log("\n⚙  Building Rust cdylib (release) …");
execSync("cargo build --release --manifest-path rust/Cargo.toml", {
  cwd: root,
  stdio: "inherit",
});

const file = addonFilename();
const outDir = join(root, "prebuilds", tag);
mkdirSync(outDir, { recursive: true });
const built = join(root, "rust", "target", "release", file);
cpSync(built, join(outDir, file));
console.log(`✔ Staged ${file} → prebuilds/${tag}/${file}`);
