/**
 * End-to-end AOT specialized-plugin-tier verification: compile an app whose
 * ONLY lifecycle is the declarable plugin layer (cors + security) and whose
 * route reads nothing but `ctx.json`, then serve real requests through the
 * compiled plugins.
 *
 * Why a script and not a vitest test: booting the generated server needs plain
 * Bun (`Bun.serve` + a dynamically imported artifact); vitest workers run under
 * Node (see `.github/workflows/ci.yml` — the same reason `verify-aot-abort.ts`
 * exists). The vitest `plugin-specialized-members.test.ts` covers the structural
 * emission and re-runs the behavioral check when its worker happens to be Bun.
 *
 * Regression target: a route on the usage-specialized tier used to emit ONLY
 * the members its handler referenced, so the cors/security hooks (whose
 * context usage is DECLARED) read `ctx.headers === undefined` on a lean route
 * and threw `TypeError` → 500 on every request. The emitted ctx is now the
 * ROUTE ∪ PLUGIN usage union; this script proves the served path.
 *
 * Builds INSIDE the workspace so the generated artifact resolves `@ignex/core`.
 * Usage: bun scripts/verify-aot-plugin-specialized.ts
 * Exits 0 on success, 1 on any mismatch.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAsync } from "@ignex/compiler";

const base = join(process.cwd(), "packages/compiler", ".tmp-aot-plugin-specialized");
mkdirSync(base, { recursive: true });
const outDir = mkdtempSync(join(base, "build-"));
const routesDir = join(outDir, "routes");
mkdirSync(routesDir, { recursive: true });

// A route that reads NOTHING but `ctx.json` — the exact shape that used to
// hand the plugin hooks a ctx without their declared members.
writeFileSync(
  join(routesDir, "hello.get.ts"),
  `export default (ctx: { json: (value: unknown) => Response }) => ctx.json({ ok: true });\n`,
);
writeFileSync(
  join(outDir, "app.config.ts"),
  `import { cors, security } from "@ignex/core";
export const plugins = [
  cors({ origin: ["https://example.com"] }),
  security({ contentSecurityPolicy: "default-src 'self'" }),
];
export const server = { port: 41113 };
`,
);

const result = await buildAsync({
  routesDir,
  outDir,
  outFile: "__server.js",
  appConfig: join(outDir, "app.config.ts"),
  target: "bun",
  optimizationLevel: 3,
  minify: false,
  sourceMap: false,
  generateTypes: false,
  generateOpenAPI: false,
  generateClient: false,
});

let failures = 0;
const check = (name: string, cond: boolean): void => {
  if (!cond) {
    failures++;
    console.log(`FAIL ${name}`);
  }
};

for (const e of result.errors) console.log("compiler error:", e.message);
check("no compiler errors", result.errors.length === 0);

// Structural: the emitted ctx literal carries the plugin layer's members even
// though the route itself reads only `ctx.json`.
const literal = result.code.match(/ctx = \{ [^}]*\};/)?.[0] ?? "";
check(
  "route stays specialized (no full-context assignment)",
  !/^\s*ctx = createContext\(/m.test(result.code),
);
check("plugin headers member emitted", literal.includes("headers: req.headers"));
check("plugin method member emitted", literal.includes("method: req.method"));
check("plugin req member emitted", /,\s*req\s*(?:,|:)/.test(literal));

// Boot the emitted (pre-link) server and serve real requests through the
// compiled plugin hooks. `Bun.serve` starts a listener on PORT; stop in finally.
const PORT = 40317;
process.env.PORT = String(PORT);
process.env.IGNEX_HTTPS = "0";
const serverPath = join(outDir, "__server.js");

let stop: (() => void) | undefined;
try {
  writeFileSync(serverPath, `${result.code}\nexport { __routes };\n`);
  const mod = (await import(serverPath)) as {
    default?: { stop(drain?: boolean): void };
    __routes: Record<string, { GET?: (req: Request) => Response | Promise<Response> }>;
  };
  check("generated server boots", typeof mod.default !== "undefined");
  stop = () => mod.default?.stop(true);

  const get = mod.__routes["/hello"]?.GET;
  check("route /hello GET is bound", typeof get === "function");

  const noOrigin = await get?.(new Request(`http://localhost:${PORT}/hello`));
  check("plain GET → 200 (was 500: cors read ctx.headers = undefined)", noOrigin?.status === 200);
  check("plain GET → { ok: true }", (await noOrigin?.json())?.ok === true);

  const withOrigin = await get?.(
    new Request(`http://localhost:${PORT}/hello`, {
      headers: { origin: "https://example.com" },
    }),
  );
  check("Origin GET → 200", withOrigin?.status === 200);
  check(
    "cors onResponse ran (access-control-allow-origin echoed)",
    withOrigin?.headers.get("access-control-allow-origin") === "https://example.com",
  );
  check(
    "security onResponse ran (CSP applied)",
    withOrigin?.headers.get("content-security-policy") === "default-src 'self'",
  );
} catch (err) {
  check(`server boots (${(err as Error).message})`, false);
}
try {
  stop?.();
} catch {
  // best-effort shutdown
}

console.log(
  failures === 0
    ? "AOT specialized-plugin tier verified: plugin-declared members present on lean routes; requests served (0 failures)."
    : `AOT specialized-plugin tier verification FAILED (${failures} failures).`,
);
try {
  rmSync(base, { recursive: true, force: true });
} catch {
  // best-effort cleanup
}
process.exit(failures === 0 ? 0 : 1);
