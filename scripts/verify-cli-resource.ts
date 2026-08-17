/**
 * End-to-end CLI resource verification: run `ignex resource User --rbac`,
 * then AOT-compile the generated model + CRUD routes and assert the RBAC
 * guards are emitted. Usage: bun scripts/verify-cli-resource.ts
 * Exits 0 on success, 1 on any mismatch.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAsync } from "@ignex/compiler";
import { runResource } from "../packages/cli/src/commands/resource.js";

const base = join(process.cwd(), ".tmp-cli-resource");
rmSync(base, { recursive: true, force: true });
mkdirSync(base, { recursive: true });

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

// 2. AOT-compile the generated routes (compiler recognizes withGuards).
const result = await buildAsync({
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
  treeshakeRuntime: true,
  routeCache: false,
  precompileValidators: false,
  precompileSerializers: false,
});

for (const e of result.errors) console.log("compiler error:", e.message);
check("generated resource compiles (0 errors)", result.errors.length === 0);
check(
  "rbac guards emitted",
  result.code.includes('can("users:read")') && result.code.includes('can("users:write")'),
);
check("guard hook chain wired", /\[__guard__h\d+_\d+/.test(result.code));

console.log(
  failures === 0
    ? "CLI resource verified: generated files + AOT compile + RBAC guards (0 failures)."
    : `CLI resource verification FAILED (${failures} failures).`,
);
rmSync(base, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
