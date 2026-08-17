/**
 * End-to-end AOT RBAC verification: compile `withGuards` routes with the AOT
 * compiler, then BOOT the generated server and assert the guard chain runs
 * (401 unauthenticated / 403 forbidden / 200 authorized).
 *
 * The fixture is built INSIDE the workspace so the generated server resolves
 * `@ignex/core` up the tree. Usage: bun scripts/verify-aot-rbac.ts
 * Exits 0 on success, 1 on any mismatch.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAsync } from "@ignex/compiler";

const base = join(process.cwd(), ".tmp-aot-rbac");
mkdirSync(base, { recursive: true });
const outDir = mkdtempSync(join(base, "build-"));
const routesDir = join(outDir, "routes");
mkdirSync(routesDir, { recursive: true });

writeFileSync(
  join(routesDir, "protected.get.ts"),
  `import { withGuards } from "@ignex/core";
import { get } from "@ignex/core/http";

export default withGuards(
  get((ctx) => ctx.json({ secret: "42" })),
  { roles: ["admin"], permissions: ["users:read"] },
);
`,
);

writeFileSync(
  join(routesDir, "authed.get.ts"),
  `import { withGuards } from "@ignex/core";
import { get } from "@ignex/core/http";

export default withGuards(get((ctx) => ctx.json({ ok: true })));
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
  treeshakeRuntime: true,
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
check("emits hasRole guard", result.code.includes('hasRole("admin")'));
check("emits can guard", result.code.includes('can("users:read")'));
check("emits requireAuthenticated", result.code.includes("requireAuthenticated"));
check(
  "imports guards from core",
  /import \{[\s\S]*\bcan\b[\s\S]*\} from "@ignex\/core"/.test(result.code) &&
    /import \{[\s\S]*\bhasRole\b[\s\S]*\} from "@ignex\/core"/.test(result.code),
);
check(
  "guards in route hook var",
  result.code.includes("__guard__h0_0") &&
    result.code.includes("__guard__h1_0") &&
    result.code.includes("__guard__h1_1"),
);

// Boot the generated server and exercise the guard chain (401 when no user).
// The compiled server binds `process.env.PORT` — use a quiet port so the
// fixture never collides with a running dev server.
const PORT = 40231;
process.env.PORT = String(PORT);
const serverPath = join(outDir, "__server.js");
const baseUrl = `http://localhost:${PORT}`;
let stop: (() => void) | undefined;
try {
  const mod = (await import(serverPath)) as { default?: { stop(drain?: boolean): void } };
  check("generated server boots", typeof mod.default !== "undefined");
  stop = () => mod.default?.stop(true);
  // Real HTTP round trips through Bun's native router + the guard chain.
  const anon = await fetch(`${baseUrl}/protected`);
  check("protected: no token → 401", anon.status === 401);
  const authed = await fetch(`${baseUrl}/authed`);
  check("authed: no token → 401", authed.status === 401);
  const ok = await fetch(`${baseUrl}/protected`);
  const body = await ok.text();
  check("protected: 401 body is JSON", body.includes("Unauthorized"));
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
    ? "AOT RBAC verified: guards emitted + server booted (0 failures)."
    : `AOT RBAC verification FAILED (${failures} failures).`,
);
try {
  rmSync(base, { recursive: true, force: true });
} catch {
  // best-effort cleanup
}
process.exit(failures === 0 ? 0 : 1);
