/**
 * End-to-end CLI resource verification: run `ignex resource User --rbac`,
 * then AOT-compile the generated model + CRUD routes and assert the RBAC
 * guards are emitted. Usage: bun scripts/verify-cli-resource.ts
 * Exits 0 on success, 1 on any mismatch.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runResource } from "../packages/cli/src/commands/resource.js";

// The probe MUST live outside the repo (os.tmpdir, like verify-scaffold-e2e's
// scratch): once the CLI's `loadConfig` runtime-imports `ignex.config.mjs`
// from a path under this repo, Bun binds the import to the repo's
// tsconfig.json — whose `paths` map `@ignex/*` to `packages/*/src` — and the
// bundler then applies that mapping to EVERY later build in the process. Bare
// specifiers the paths don't cover (`typebox`, `mongodb`, `@ignex/ninox`)
// hard-fail even with a correct node_modules walk-up. A tmpdir probe has no
// ancestor tsconfig, so nothing gets bound.
const base = mkdtempSync(join(tmpdir(), "ignex-cli-resource-"));

writeFileSync(
  join(base, "ignex.config.mjs"),
  `export default { routesDir: "src/routes", outDir: ".ignex", outFile: "server.js" };\n`,
);

let failures = 0;
const check = (name: string, cond: boolean): void => {
  if (!cond) {
    failures++;
    console.log(`FAIL ${name}`);
  }
};

// 1. Run the resource generator with RBAC guard pre-wiring.
await runResource([
  "User",
  "--fields",
  "email:string(format email), role:enum(admin,editor)",
  "--rbac",
  "--root",
  base,
]);

const modelPath = join(base, "src/models/users.ts");
check("model generated", existsSync(modelPath));
for (const f of ["index.get.ts", "[id].get.ts", "index.post.ts", "[id].patch.ts", "[id].del.ts"]) {
  check(`route generated: ${f}`, existsSync(join(base, "src/routes/api/users", f)));
}
check("db bootstrap generated", existsSync(join(base, "src/db.ts")));

// 1a. Offline dependency resolution: the generated files import typebox
//     (route schemas), mongodb + @ignex/ninox (db bootstrap/client), which a
//     real consumer app resolves from its own package.json install. The probe
//     has none, so link the workspace's installed copies (same pattern as
//     verify-scaffold-e2e.ts — workspace @ignex/* lives under
//     packages/app/node_modules/@ignex, not the root).
mkdirSync(join(base, "node_modules"), { recursive: true });
symlinkSync(
  join(process.cwd(), "packages", "app", "node_modules", "@ignex"),
  join(base, "node_modules", "@ignex"),
  "dir",
);
symlinkSync(
  join(process.cwd(), "packages", "compiler", "node_modules", "typebox"),
  join(base, "node_modules", "typebox"),
  "dir",
);
symlinkSync(
  join(process.cwd(), "packages", "app", "node_modules", "mongodb"),
  join(base, "node_modules", "mongodb"),
  "dir",
);

// 1b. Generated routes use framework-standard shapes (TypeBox params schema,
// canonical ninox input types, thrown errors) — no src/lib/http.ts helpers.
const getOneSrc = readFileSync(join(base, "src/routes/api/users/[id].get.ts"), "utf8");
check(
  "route validates :id via TypeBox params schema",
  getOneSrc.includes("Type.Object({ id: Type.String"),
);
check("route throws NotFoundError", getOneSrc.includes("throw new NotFoundError()"));
check("route has no toObjectId helper", !getOneSrc.includes("toObjectId"));
const postSrc = readFileSync(join(base, "src/routes/api/users/index.post.ts"), "utf8");
check("create uses ninox InsertInput", postSrc.includes("type UserInput = InsertInput<User>;"));
check("create has no errorResponse", !postSrc.includes("errorResponse"));

// 2. AOT-compile the generated routes (compiler recognizes withGuards).
//    Compiled in a SUBPROCESS: `runResource`'s config loader runtime-imports
//    ignex.config.mjs, which binds THIS process to the nearest ancestor
//    tsconfig/lockfile — in-repo probes then resolve `@ignex/*` through the
//    repo's tsconfig `paths` (and not the probe's node_modules). A fresh
//    process resolves everything from the probe's own node_modules symlinks.
const COMPILE_MARKER = "###RESULT###";
const runner = join(base, ".compile-runner.ts");
writeFileSync(
  runner,
  `import { buildAsync } from "@ignex/compiler";
const result = await buildAsync(JSON.parse(process.argv[2] ?? "{}"));
console.log(
  \`${COMPILE_MARKER}\${JSON.stringify({
    errors: result.errors.map((e) => String((e as { message?: string }).message ?? e)),
  })}\`,
);
`,
);
const opts = JSON.stringify({
  routesDir: join(base, "src/routes"),
  outDir: join(base, ".ignex"),
  outFile: "server.js",
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
const probe = spawnSync(process.execPath, [runner, opts], {
  cwd: base,
  encoding: "utf8",
  timeout: 120_000,
});
const resultLine = (probe.stdout ?? "").split("\n").find((line) => line.startsWith(COMPILE_MARKER));
const compiled = resultLine
  ? (JSON.parse(resultLine.slice(COMPILE_MARKER.length)) as { errors: string[] })
  : null;
if (!compiled) {
  failures++;
  console.log(`FAIL compile subprocess (exit ${probe.status})`);
  if (probe.stderr) console.log(probe.stderr.slice(0, 2000));
}
for (const e of compiled?.errors ?? []) console.log("compiler error:", e);
check("generated resource compiles (0 errors)", (compiled?.errors.length ?? 1) === 0);

// Guards are asserted against the EMITTED artifact (minify is off, so the
// identifiers survive).
const emitted = existsSync(join(base, ".ignex", "server.js"))
  ? readFileSync(join(base, ".ignex", "server.js"), "utf8")
  : "";
check(
  "rbac guards emitted",
  emitted.includes('can("users:read")') && emitted.includes('can("users:write")'),
);
check(
  "guard hook chain wired",
  // Guards wire either into a bracketed per-route array or merged into the
  // config-driven before chain (`[..., __guard__h0_0]`) when the route module
  // was loadable at build time.
  /\[\s*__guard__h\d+_\d+/.test(emitted) || /,\s*__guard__h\d+_\d+\]/.test(emitted),
);

console.log(
  failures === 0
    ? "CLI resource verified: generated files + AOT compile + RBAC guards (0 failures)."
    : `CLI resource verification FAILED (${failures} failures).`,
);
rmSync(base, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
