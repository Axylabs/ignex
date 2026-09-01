/**
 * Stability + security regression tests for the compiler.
 *
 * Covers flaw classes found in a compiler audit:
 *  - discovery/cache FS walks vs symlink cycles (hang / exponential blowup)
 *  - generated-artifact identifier safety (routes.d.ts must typecheck for any
 *    legal filename param segment)
 *  - incremental cache hardening (a tampered record must not read outside
 *    outDir)
 *  - generated dev-overlay HTML injection resistance (String.replace `$`
 *    substitution patterns in error messages)
 *  - hostile-but-legal route filenames lower to stable IR
 *  - route-path regex construction escapes metacharacters
 */
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMPILER_CACHE_VERSION,
  computeFingerprint,
  diffRouteFingerprints,
  fingerprintRouteFiles,
  storeCache,
  tryCachedBuild,
} from "../src/cache";
import { DiagnosticCollector } from "../src/diagnostics";
import { buildAsync, mergeOptions } from "../src/index";
import { parseRouteFilename } from "../src/ir/lower";
import { silentLogger } from "../src/logger";
import { normalizeHttpMethod } from "../src/options";
import { generateRouteTypes } from "../src/phases/artifacts/route-types";
import { HELPER_SOURCES } from "../src/phases/codegen/helpers";
import { hookIdent } from "../src/phases/codegen/identifiers";
import { scanDirectory } from "../src/phases/discovery";
import { escapeRegExp, pathRegexSource, wildcardNames } from "../src/utils/route-path";

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `ignex-sec-${prefix}-`));

const makeCtx = () => ({
  logger: silentLogger,
  diagnostics: new DiagnosticCollector(),
});

/** A minimal routes tree: one static GET file. */
const seedRoutes = (routesDir: string): void => {
  writeFileSync(join(routesDir, "ping.get.ts"), "export default () => new Response('pong');\n");
};

describe("discovery: filesystem stability", () => {
  it("terminates on a self-referential symlink cycle and scans each file once", () => {
    const root = tmp("cycle");
    const routesDir = join(root, "routes");
    mkdirSync(routesDir, { recursive: true });
    seedRoutes(routesDir);
    // `loop -> .` — before the cycle guard this re-descended until the
    // kernel's ELOOP cap (~40 levels), emitting dozens of duplicate paths.
    symlinkSync(".", join(routesDir, "loop"));

    const files = scanDirectory(routesDir);
    expect(files).toEqual(["ping.get.ts"]);
  });

  it("terminates on two mutually-referencing symlinked directories", () => {
    const root = tmp("mutual");
    const routesDir = join(root, "routes");
    const a = join(routesDir, "a");
    const b = join(routesDir, "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, "x.get.ts"), "export default () => 1;\n");
    writeFileSync(join(b, "y.get.ts"), "export default () => 2;\n");
    symlinkSync(b, join(a, "to-b"));
    symlinkSync(a, join(b, "to-a"));

    const files = scanDirectory(routesDir).sort();
    // Deterministic "first alias wins": `b` is entered once (via a/to-b), and
    // the b→a link is recognized as an already-scanned real directory. Each
    // real dir contributes its files exactly once — finite, stable output.
    expect(files).toEqual(["a/to-b/y.get.ts", "a/x.get.ts"]);
  });

  it("skips a dangling symlinked directory without throwing", () => {
    const root = tmp("dangling");
    const routesDir = join(root, "routes");
    mkdirSync(routesDir, { recursive: true });
    seedRoutes(routesDir);
    symlinkSync(join(root, "does-not-exist"), join(routesDir, "ghost"));

    expect(() => scanDirectory(routesDir)).not.toThrow();
    expect(scanDirectory(routesDir)).toEqual(["ping.get.ts"]);
  });
});

describe("cache fingerprint: filesystem stability", () => {
  it("fingerprint of a cyclic tree equals the fingerprint of the same tree without the cycle", () => {
    const plain = tmp("fp-plain");
    const cyclic = tmp("fp-cyclic");
    for (const root of [plain, cyclic]) {
      const routesDir = join(root, "routes");
      mkdirSync(routesDir, { recursive: true });
      seedRoutes(routesDir);
      // listFiles ignores dot-entries; name the cycle link normally so the
      // walk actually sees it (pre-fix behavior: unbounded re-hash).
      if (root === cyclic) symlinkSync(".", join(routesDir, "self"));
    }

    const optsOf = (root: string) =>
      mergeOptions({ routesDir: join(root, "routes"), outDir: join(root, "out") });

    // Both trees contain exactly the same real files, so their route
    // fingerprints must match — and computing them must terminate promptly
    // (default vitest timeout is the hang guard). RouteFingerprints are
    // path-relative and content-keyed, so they are directly comparable.
    expect(fingerprintRouteFiles(optsOf(cyclic))).toEqual(fingerprintRouteFiles(optsOf(plain)));
  });

  it("route fingerprint sets are cycle-stable", () => {
    const root = tmp("rfp");
    const routesDir = join(root, "routes");
    mkdirSync(routesDir, { recursive: true });
    seedRoutes(routesDir);
    symlinkSync(".", join(routesDir, "self"));

    const opts = mergeOptions({ routesDir, outDir: join(root, "out") });
    expect(fingerprintRouteFiles(opts)).toHaveLength(1);

    const again = fingerprintRouteFiles(opts);
    expect(diffRouteFingerprints(again, fingerprintRouteFiles(opts)).changed).toEqual([]);
  });
});

describe("incremental cache hardening", () => {
  it("ignores a tampered record whose outFile escapes outDir (no arbitrary read)", async () => {
    const root = tmp("escape");
    const outDir = join(root, "out");
    const routesDir = join(root, "routes");
    mkdirSync(outDir, { recursive: true });
    mkdirSync(routesDir, { recursive: true });
    seedRoutes(routesDir);

    const opts = mergeOptions({
      routesDir,
      outDir,
      outFile: "server.js",
      incremental: true,
      minify: false,
      sourceMap: false,
    });

    // A secret next to (not inside) outDir that a poisoned record points at.
    const secret = join(root, "secret.js");
    writeFileSync(secret, "TOPSECRET;\n");

    // Craft a record that passes the fingerprint check but smuggles an
    // escaping outFile path.
    writeFileSync(
      join(outDir, ".ignex-cache.json"),
      JSON.stringify({
        version: COMPILER_CACHE_VERSION,
        fingerprint: computeFingerprint(opts),
        outFile: "../secret.js",
        timestamp: new Date().toISOString(),
      }),
    );

    const ctx = makeCtx();
    const hit = await tryCachedBuild(opts, ctx as never);
    expect(hit).toBeUndefined();
    expect(ctx.diagnostics.warnings.some((w) => w.code === "IGN_BUILD_CACHE_INVALID")).toBe(true);
  });

  it("ignores a record with a non-string or empty outFile without throwing", async () => {
    const root = tmp("badtype");
    const outDir = join(root, "out");
    const routesDir = join(root, "routes");
    mkdirSync(outDir, { recursive: true });
    mkdirSync(routesDir, { recursive: true });
    seedRoutes(routesDir);

    const opts = mergeOptions({
      routesDir,
      outDir,
      outFile: "server.js",
      incremental: true,
      minify: false,
      sourceMap: false,
    });

    for (const bad of [42, "", null]) {
      writeFileSync(
        join(outDir, ".ignex-cache.json"),
        JSON.stringify({
          version: COMPILER_CACHE_VERSION,
          fingerprint: computeFingerprint(opts),
          outFile: bad,
          timestamp: new Date().toISOString(),
        }),
      );
      await expect(tryCachedBuild(opts, makeCtx() as never)).resolves.toBeUndefined();
    }
  });
});

describe("generated artifacts: identifier safety", () => {
  const irWithParams = (paramNames: string[]) =>
    ({
      source: {
        method: "GET",
        path: `/${paramNames.map((p) => `:${p}`).join("/")}`,
        paramNames,
        isDynamic: true,
        isStatic: false,
        segmentCount: paramNames.length,
        file: "t.get.ts",
        moduleIdx: 0,
      },
      analysis: {
        usage: { body: false, query: false },
        isAsync: false,
        responseType: "json",
        hasValidation: false,
        hotnessScore: 0,
        hooks: [],
        isConstantResponse: false,
      },
      decisions: {},
      codegen: { handlerRef: "_h0" },
    }) as never;

  it("quotes param names that are not valid bare TS identifiers", () => {
    const types = generateRouteTypes([irWithParams(["user-id", "2fa", "user name"])]);
    // Quoted keys are always legal interface members; bare ones are not.
    expect(types).toContain('"user-id": string;');
    expect(types).toContain('"2fa": string;');
    expect(types).toContain('"user name": string;');
    expect(types).not.toMatch(/^\s+user-id:/m);
  });

  it("keeps normal param names working (quoted form)", () => {
    const types = generateRouteTypes([irWithParams(["id"])]);
    expect(types).toContain('"id": string;');
  });
});

describe("hostile/odd route filenames lower stably", () => {
  it.each([
    ["users/[user-id].get.ts", "/users/:user-id", ["user-id"]],
    ["[2fa].get.ts", "/:2fa", ["2fa"]],
    ["[用户].post.ts", "/:用户", ["用户"]],
    ["docs/[...rest].get.ts", "/docs/*rest", ["rest"]],
  ])("%s → %s", (file, path, params) => {
    const parsed = parseRouteFilename(file);
    expect(parsed?.path).toBe(path);
    expect(parsed?.paramNames).toEqual(params);
  });

  it("double method suffix keeps only the last as the method", () => {
    const parsed = parseRouteFilename("thing.get.post.ts");
    expect(parsed?.method).toBe("POST");
    expect(parsed?.path).toBe("/thing.get");
  });

  it("method aliases normalize case-insensitively (del → DELETE)", () => {
    expect(normalizeHttpMethod("del")).toBe("DELETE");
    expect(normalizeHttpMethod("patch")).toBe("PATCH");
    expect(normalizeHttpMethod("nope")).toBeUndefined();
  });

  it("wildcard extraction ignores non-word characters after *", () => {
    expect(wildcardNames("/files/*path")).toEqual(["path"]);
    expect(wildcardNames("/files/*")).toEqual([]);
  });
});

describe("route-path regex construction", () => {
  it("escapes regex metacharacters in literal segments", () => {
    expect(escapeRegExp("a.b(c)d[e]f$g|h?i*j")).toBe("a\\.b\\(c\\)d\\[e\\]f\\$g\\|h\\?i\\*j");
  });

  it("builds anchored matchers where literal dots do not match arbitrary chars", () => {
    const re = new RegExp(pathRegexSource("/v1.0/users"));
    expect(re.test("/v1.0/users")).toBe(true);
    expect(re.test("/v1X0/users")).toBe(false);
  });

  it("dynamic segments match one segment; wildcards span slashes", () => {
    const dynamic = new RegExp(pathRegexSource("/users/:id"));
    expect(dynamic.test("/users/42")).toBe(true);
    expect(dynamic.test("/users/42/posts")).toBe(false);

    const wild = new RegExp(pathRegexSource("/static/*rest"));
    expect(wild.test("/static/a/b/c")).toBe(true);
  });
});

describe("dev overlay: message injection resistance", () => {
  it("uses a function replacer so `$&` in messages cannot corrupt the overlay", () => {
    // A string replacer treats `$&`, `` $` ``, `$'` as substitution patterns;
    // compiler/module errors legitimately contain `$&` (module resolution).
    const emitted = HELPER_SOURCES.__fallback ?? "";
    expect(emitted).toMatch(/\.replace\("__MESSAGE__", \(\) =>/);
  });

  it("documents the hazard: string replacer corrupts `$&` messages", () => {
    const html = "<pre>__MESSAGE__</pre>";
    const msg = "Cannot find module '$&' from 'x'";
    const broken = html.replace("__MESSAGE__", msg.replace(/&/g, "&amp;").replace(/</g, "&lt;"));
    expect(broken).toContain("__MESSAGE__amp;"); // the corruption being guarded against

    const safe = html.replace("__MESSAGE__", () =>
      msg.replace(/&/g, "&amp;").replace(/</g, "&lt;"),
    );
    expect(safe).toBe("<pre>Cannot find module '$&amp;' from 'x'</pre>");
  });
});

describe("hook identifier normalization", () => {
  it("keeps distinct hook names on distinct identifiers (no duplicate declarations)", () => {
    // `auth-basic` and `auth_basic` sanitize to the same base; the raw name
    // is mixed into a suffix so both can be imported side by side.
    expect(hookIdent("auth-basic")).not.toBe(hookIdent("auth_basic"));
    expect(hookIdent("auth-basic")).toMatch(/^hook_auth_basic_[0-9a-f]+$/);
    expect(hookIdent("auth_basic")).toBe("hook_auth_basic");
  });

  it("keeps clean names on the historical form", () => {
    expect(hookIdent("session")).toBe("hook_session");
    expect(hookIdent("$auth")).toBe("hook_$auth");
    expect(hookIdent("session")).toBe(hookIdent("session"));
  });

  it("suffixes are deterministic across builds", () => {
    expect(hookIdent("auth-basic")).toBe(hookIdent("auth-basic"));
  });
});

describe("hook identifier collision (end-to-end compile)", () => {
  it("compiles two hook modules whose names sanitize identically", async () => {
    const root = tmp("hooks-e2e");
    const routesDir = join(root, "routes");
    const hooksDir = join(root, "hooks");
    mkdirSync(routesDir, { recursive: true });
    mkdirSync(hooksDir, { recursive: true });

    writeFileSync(
      join(routesDir, "secure.get.ts"),
      `export const config = { hooks: ["auth-basic", "auth_basic"] };\nexport default () => "ok";\n`,
    );
    writeFileSync(join(hooksDir, "auth-basic.ts"), "export default () => 1;\n");
    writeFileSync(join(hooksDir, "auth_basic.ts"), "export default () => 2;\n");

    const result = await buildAsync({
      routesDir,
      outDir: join(root, "out"),
      outFile: "server.js",
      incremental: false,
      minify: false,
      sourceMap: false,
      hooksDir,
    });

    // Pre-fix, both imported as `hook_auth_basic` → duplicate declaration,
    // a confusing Bun link failure instead of this clean build.
    expect(result.errors).toEqual([]);

    const idKebab = hookIdent("auth-basic");
    const idSnake = hookIdent("auth_basic");
    expect(result.code).toContain(`import ${idKebab} from`);
    expect(result.code).toContain(`import ${idSnake} from`);
    // Both hooks are referenced from the route's before chain (declaration +
    // use ⇒ each identifier appears more than once).
    expect(result.code.split(idKebab).length).toBeGreaterThan(2);
    expect(result.code.split(idSnake).length).toBeGreaterThan(2);
  });
});

describe("fingerprint sharing (single computation per build)", () => {
  const makeCacheLayout = () => {
    const root = tmp("share");
    const outDir = join(root, "out");
    const routesDir = join(root, "routes");
    mkdirSync(outDir, { recursive: true });
    mkdirSync(routesDir, { recursive: true });
    seedRoutes(routesDir);
    const opts = mergeOptions({
      routesDir,
      outDir,
      outFile: "server.js",
      incremental: true,
      minify: false,
      sourceMap: false,
      // Focus the companion-artifact guard on `manifest.json` alone.
      precompileValidators: false,
      precompileSerializers: false,
      generateTypes: false,
      generateOpenAPI: false,
      generateClient: false,
    });
    return { opts, outDir, routesDir };
  };

  it("tryCachedBuild hits when given the precomputed fingerprint", async () => {
    const { opts, outDir } = makeCacheLayout();
    const ctx = makeCtx();
    const outPath = join(outDir, "server.js");
    await writeFile(outPath, "export default {};\n");
    // A real build writes companion artifacts; the cache treats their absence
    // as a miss (broken output guard).
    await writeFile(join(outDir, "manifest.json"), "{}\n");
    await storeCache(opts, ctx as never, outPath);

    const hit = await tryCachedBuild(opts, ctx as never, computeFingerprint(opts));
    expect(hit?.code).toBe("export default {};\n");
  });

  it("storeCache honors an explicit fingerprint + route file list", async () => {
    const { opts, outDir, routesDir } = makeCacheLayout();
    writeFileSync(join(routesDir, "extra.get.ts"), "export default () => 2;\n");

    // Pass only ONE route file: the record must contain exactly that
    // fingerprint set (proving no re-walk happened) and the exact fingerprint
    // handed in (proving no recomputation).
    const files = ["ping.get.ts"];
    await storeCache(
      opts,
      makeCtx() as never,
      join(outDir, "server.js"),
      undefined,
      "deadbeef",
      files,
    );

    const record = JSON.parse(readFileSync(join(outDir, ".ignex-cache.json"), "utf8")) as {
      fingerprint: string;
      routes: Array<{ relPath: string }>;
    };
    expect(record.fingerprint).toBe("deadbeef");
    expect(record.routes.map((r) => r.relPath)).toEqual(["ping.get.ts"]);
  });

  it("writes the cache record as compact JSON", async () => {
    const { opts, outDir } = makeCacheLayout();
    await storeCache(opts, makeCtx() as never, join(outDir, "server.js"));

    const raw = readFileSync(join(outDir, ".ignex-cache.json"), "utf8");
    expect(raw).not.toContain("\n"); // no pretty-printing
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
