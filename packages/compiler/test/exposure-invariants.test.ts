/**
 * @fileoverview Defense-in-depth pins for error-detail exposure — one
 * assertion block per LAYER of the chain, so a regression at any single layer
 * fails a test instead of silently reopening the leak the layer exists to
 * prevent.
 *
 * The chain (each layer independently fails closed for production shapes):
 *
 *   1. `mergeOptions` (validate.ts) — forces `exposeErrorDetails: false` onto
 *      a production-shaped build whose option is unset. Pinned in
 *      options.test.ts; not duplicated here.
 *   2. `getConfig` (codegen/config.ts) — the resolution for callers that reach
 *      codegen without passing through mergeOptions (internal phases, direct
 *      tests): `?? !isProductionBuild(opts)`, so the fallback is ALSO
 *      shape-aware and fails closed.
 *   3. Emission (header.ts) — `const EXPOSE_ERRORS = <bool>` baked from the
 *      BUILD shape; pinned end-to-end in production-development.test.ts.
 *   4. The emitted error boundary (`__handleError`) consults that baked const
 *      — never a runtime env read, so launching a prod artifact without
 *      `NODE_ENV=production` cannot flip exposure back on at runtime.
 *
 * Plus the cache contract that keeps the layers consistent across rebuilds:
 * `NODE_ENV` is part of the whole-build fingerprint (cache.ts's documented
 * exception to "generated code is env-independent"), so a production build can
 * never be served a dev-shaped artifact from the incremental cache — or vice
 * versa.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeFingerprint } from "../src/cache";
import { mergeOptions } from "../src/index";
import { createDefaultOptions } from "../src/options";
import { getConfig } from "../src/phases/codegen/config";
import { HELPER_SOURCES } from "../src/phases/codegen/helpers";

const origNodeEnv = process.env.NODE_ENV;
const origIgnexDebug = process.env.IGNEX_DEBUG;

afterEach(() => {
  if (origNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = origNodeEnv;
  if (origIgnexDebug === undefined) delete process.env.IGNEX_DEBUG;
  else process.env.IGNEX_DEBUG = origIgnexDebug;
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  }
});

let tmpRoot: string | undefined;

/** Deterministic env: no production shape and no IGNEX_DEBUG opt-out. */
const cleanEnv = (): void => {
  delete process.env.NODE_ENV;
  delete process.env.IGNEX_DEBUG;
};

describe("getConfig resolves fail-closed without mergeOptions", () => {
  it("defaults exposure OFF for a production shape even when the option is unset", () => {
    cleanEnv();
    const cfg = getConfig({
      ...createDefaultOptions(),
      exposeErrorDetails: undefined,
      production: true,
    });
    // Layer 2 of the chain: if a caller ever bypasses mergeOptions, the
    // codegen config still refuses to expose details on a production shape.
    expect(cfg.exposeErrorDetails).toBe(false);
  });

  it("defaults exposure ON for a dev shape (local debuggability)", () => {
    cleanEnv();
    const cfg = getConfig({
      ...createDefaultOptions(),
      exposeErrorDetails: undefined,
      production: false,
    });
    expect(cfg.exposeErrorDetails).toBe(true);
  });
});

describe("emitted error boundary consults the baked const", () => {
  it("__handleError passes the baked EXPOSE_ERRORS — never a runtime env read", () => {
    const src = HELPER_SOURCES.__handleError;
    expect(src).toContain("errorToResponse(err, EXPOSE_ERRORS, ctx)");
    // The BUILD shape is the authority (the same contract as
    // `__serveOptions.development = false`). If the error path ever reads
    // process.env, a prod artifact launched without NODE_ENV=production
    // would flip exposure back on at runtime.
    expect(src).not.toContain("process.env");
  });
});

describe("build cache respects the exposure-relevant shape", () => {
  const makeLayout = () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ignex-exposure-"));
    const routesDir = join(tmpRoot, "routes");
    mkdirSync(routesDir, { recursive: true });
    writeFileSync(join(routesDir, "index.get.ts"), "export default () => 'hi';\n");
    return { routesDir, outDir: tmpRoot };
  };

  const makeOpts = (extra: Record<string, unknown> = {}) => {
    const { routesDir, outDir } = makeLayout();
    return mergeOptions({
      routesDir,
      outDir,
      outFile: "server.js",
      incremental: true,
      minify: false,
      sourceMap: false,
      ...extra,
    });
  };

  it("fingerprint changes when the build shape changes (the NODE_ENV exception)", () => {
    cleanEnv();
    const dev = computeFingerprint(makeOpts());

    process.env.NODE_ENV = "production";
    const prod = computeFingerprint(makeOpts());

    // cache.ts documents NODE_ENV as the deliberate exception to "generated
    // code is env-independent": a production build must never be served a
    // dev-shaped artifact from the incremental cache (or vice versa). If this
    // trips because someone removed the env chunk, re-read that comment
    // before touching the assertion.
    expect(dev).not.toBe(prod);
  });

  it("fingerprint changes when exposure is explicitly flipped", () => {
    cleanEnv();
    const exposed = computeFingerprint(makeOpts());
    const closed = computeFingerprint(makeOpts({ exposeErrorDetails: false }));
    // Flipping exposure is a generated-output change: the incremental cache
    // must rebuild, never serve the previous artifact.
    expect(exposed).not.toBe(closed);
  });
});
