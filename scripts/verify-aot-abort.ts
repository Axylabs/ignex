/**
 * End-to-end AOT abort verification: compile a route with the AOT compiler, then
 * invoke the emitted route wrapper with a PRE-ABORTED `Request` and assert it
 * short-circuits to the same empty 200 the interpreted lifecycle returns —
 * WITHOUT calling the handler.
 *
 * Why a script and not a vitest test: booting the generated server needs plain
 * Bun (`Bun.serve` + a dynamically imported artifact); vitest workers run under
 * Node (see `.github/workflows/ci.yml` — the same reason `verify-aot-rbac.ts`
 * exists). The vitest `abort-port.test.ts` covers the structural emission and
 * re-runs the behavioral check when its worker happens to be Bun.
 *
 * Builds INSIDE the workspace so the generated artifact resolves `@ignex/core`.
 * Usage: bun scripts/verify-aot-abort.ts
 * Exits 0 on success, 1 on any mismatch.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAsync } from "@ignex/compiler";

const base = join(process.cwd(), "packages/compiler", ".tmp-aot-abort");
mkdirSync(base, { recursive: true });
const outDir = mkdtempSync(join(base, "build-"));
const routesDir = join(outDir, "routes");
mkdirSync(routesDir, { recursive: true });

// A non-hoisted route (real core fn) that records invocation on globalThis.
writeFileSync(
  join(routesDir, "ping.get.ts"),
  `export default (ctx: { json: (value: unknown) => Response }) => {
  (globalThis as { __abortHandlerCalled?: boolean }).__abortHandlerCalled = true;
  return ctx.json({ ok: true });
};
`,
);

const result = await buildAsync({
  routesDir,
  outDir,
  outFile: "__server.js",
  target: "bun",
  optimizationLevel: 3,
  minify: false,
  sourceMap: false,
  generateTypes: false,
  generateOpenAPI: false,
  generateClient: false,
  specializeContext: true,
  hoistConstants: true,
  routeCache: false,
  precompileValidators: false,
  precompileSerializers: false,
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
check(
  "emits the abort guard",
  result.code.includes("if (req.signal.aborted) return __abortedResponse;"),
);
check("hoists the shared abortedResponse", result.code.includes("abortedResponse()"));

/** A signal that is already aborted before it is handed to the server. */
const preAborted = (): AbortSignal => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};

// Boot the emitted (pre-link) server directly so the route table is reachable.
// `Bun.serve` starts a listener on PORT; stop it in `finally`.
const PORT = 40317;
process.env.PORT = String(PORT);
process.env.IGNEX_HTTPS = "0";
const serverPath = join(outDir, "__server.js");
const globals = globalThis as { __abortHandlerCalled?: boolean };
delete globals.__abortHandlerCalled;

let stop: (() => void) | undefined;
try {
  writeFileSync(serverPath, `${result.code}\nexport { __routes };\n`);
  const mod = (await import(serverPath)) as {
    default?: { stop(drain?: boolean): void };
    __routes: Record<string, { GET?: (req: Request) => Response | Promise<Response> }>;
  };
  check("generated server boots", typeof mod.default !== "undefined");
  stop = () => mod.default?.stop(true);

  const get = mod.__routes["/ping"]?.GET;
  check("route /ping GET is bound", typeof get === "function");

  const aborted = await get?.(
    new Request(`http://localhost:${PORT}/ping`, { signal: preAborted() }),
  );
  check("pre-aborted request → 200", aborted?.status === 200);
  check("pre-aborted request → empty body", (await aborted?.text()) === "");
  check("pre-aborted request → handler NOT called", globals.__abortHandlerCalled === undefined);

  const live = await get?.(new Request(`http://localhost:${PORT}/ping`));
  check("live request → 200", live?.status === 200);
  check("live request → handler called", globals.__abortHandlerCalled === true);
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
    ? "AOT abort verified: guard emitted + pre-aborted request short-circuited (0 failures)."
    : `AOT abort verification FAILED (${failures} failures).`,
);
try {
  rmSync(base, { recursive: true, force: true });
} catch {
  // best-effort cleanup
}
process.exit(failures === 0 ? 0 : 1);
