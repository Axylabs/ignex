/** Real Bun subprocess: Vitest workers do not expose bun:ffi. */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Repo root — the spawned `bun -e` imports `./packages/...` relative to cwd,
 *  so the subprocess MUST run from the root. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Pass the local castrum override explicitly: the subprocess gets an explicit
 *  `env`, so Bun's `.env` auto-load does not apply, and without the override
 *  the loader falls back to whatever `@ignex/native` resolved from the registry
 *  (a stale copy in `packages/native/node_modules`). CI sets
 *  `IGNEX_NATIVE_PATH` itself; this falls back to the sibling dev checkout. */
const SIBLING_DIR = join(REPO_ROOT, "..", "castrum");
// Mirror the loader's dual-binary preference (v3 SIMD first, baseline fallback).
const SIBLING_ADDON = [
  join(SIBLING_DIR, "castrum.linux-x64-v3-gnu.node"),
  join(SIBLING_DIR, "castrum.linux-x64-gnu.node"),
].find((p) => existsSync(p));
const NATIVE_ENV = process.env.IGNEX_NATIVE_PATH ?? SIBLING_ADDON;

describe("shared castrum ingress binding", () => {
  it("contains shared writer exceptions and honors fail-closed policy", () => {
    const output = execFileSync(
      "bun",
      [
        "-e",
        `
      const { getFfiIngress } = await import('./packages/native/src/ffi/index.ts');
      const { createNativeIngress } = await import('./packages/native/src/ingress/index.ts');
      const binding = getFfiIngress();
      binding.ingressHandleComponents = () => { throw new Error('injected native fault'); };
      const open = createNativeIngress({}, { failClosed: false });
      const closed = createNativeIngress({}, { failClosed: true });
      const req = new Request('http://localhost/');
      const a = open.preprocess(req), b = closed.preprocess(req);
      console.log(JSON.stringify({ open: a.terminal, closed: b.response.status }));
    `,
      ],
      {
        encoding: "utf8",
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          IGNEX_NATIVE: "on",
          ...(NATIVE_ENV ? { IGNEX_NATIVE_PATH: NATIVE_ENV } : {}),
        },
      },
    );
    expect(JSON.parse(output.trim())).toEqual({ open: false, closed: 503 });
  });
  it("uses castrum's actual writers without rebinding", () => {
    const output = execFileSync(
      "bun",
      [
        "-e",
        `
      const { getFfiIngress } = await import('./packages/native/src/ffi/index.ts');
      const { loadCastrumModule } = await import('./packages/native/src/loader.ts');
      const mod = await loadCastrumModule();
      const shared = mod.getIngressBinding();
      const actual = getFfiIngress();
      console.log(JSON.stringify({ available: !!actual,
        same: !!actual && actual.ingressHandleComponents === shared.ingressHandleComponents
          && actual.ingressHandlePacked === shared.ingressHandlePacked
          && actual.ingressLayout === shared.ingressLayout }));
    `,
      ],
      {
        encoding: "utf8",
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          IGNEX_NATIVE: "on",
          ...(NATIVE_ENV ? { IGNEX_NATIVE_PATH: NATIVE_ENV } : {}),
        },
      },
    );
    expect(JSON.parse(output.trim())).toEqual({ available: true, same: true });
  });
});
