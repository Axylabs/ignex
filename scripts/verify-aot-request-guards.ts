import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAsync } from "@ignex/compiler";

const base = join(process.cwd(), "packages/compiler/.tmp-aot-request-guards");
mkdirSync(base, { recursive: true });
const outDir = mkdtempSync(join(base, "build-"));
const routesDir = join(outDir, "routes");
mkdirSync(routesDir, { recursive: true });

writeFileSync(
  join(routesDir, "slow.get.ts"),
  `export default async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  return new Response("late");
};
`,
);
writeFileSync(join(routesDir, "constant.get.ts"), `export default () => "constant";\n`);

let failures = 0;
const check = (name: string, condition: boolean): void => {
  if (!condition) {
    failures += 1;
    console.log(`FAIL ${name}`);
  }
};

let stop: (() => void) | undefined;
try {
  const result = await buildAsync({
    routesDir,
    outDir,
    outFile: "__server.js",
    target: "bun",
    handlerTimeoutMs: 20,
    maxHeaderBytes: 512,
    minify: false,
    sourceMap: false,
    incremental: false,
    generateTypes: false,
    generateOpenAPI: false,
    generateClient: false,
    precompileValidators: false,
    precompileSerializers: false,
  });
  for (const error of result.errors) console.log("compiler error:", error.message);
  check("no compiler errors", result.errors.length === 0);
  check(
    "timeout option reaches generated code",
    result.code.includes("const __HANDLER_TIMEOUT_MS = __serverCfg.handlerTimeoutMs ?? 20;"),
  );
  check(
    "header cap reaches generated code",
    result.code.includes("const __MAX_HEADER_BYTES = 512;"),
  );
  check("constant route stays behind the guard", !result.code.includes("STATIC_RES_GET_constant"));

  const port = 40441;
  process.env.PORT = String(port);
  process.env.IGNEX_HTTPS = "0";
  const server = (await import(join(outDir, "__server.js"))) as {
    default?: { stop(force?: boolean): void };
  };
  stop = () => server.default?.stop(true);
  const baseUrl = `http://localhost:${port}`;

  const fast = await fetch(`${baseUrl}/constant`);
  const fastBody = await fast.text();
  check("ordinary constant route still works", fast.status === 200 && fastBody === '"constant"');
  if (fast.status !== 200 || fastBody !== '"constant"') {
    console.log(`constant route returned ${fast.status}: ${fastBody}`);
  }

  const slow = await fetch(`${baseUrl}/slow`);
  check("slow handler returns 503", slow.status === 503);
  check("timeout reason is stable", slow.headers.get("x-ignex-reason") === "handler-timeout");
  check(
    "timeout body is classified",
    JSON.stringify(await slow.json()).includes("IGN_HANDLER_TIMEOUT"),
  );
  const slowAgain = await fetch(`${baseUrl}/slow`);
  check("repeated timeouts return fresh bodies", slowAgain.status === 503);
  check(
    "repeated timeout body remains readable",
    JSON.stringify(await slowAgain.json()).includes("IGN_HANDLER_TIMEOUT"),
  );

  const headers = { "x-bomb": "a".repeat(2048) };
  const oversized = await fetch(`${baseUrl}/constant`, { headers });
  check("constant-eligible route rejects oversized headers", oversized.status === 431);
  check(
    "header rejection has a stable reason",
    oversized.headers.get("x-ignex-reason") === "header-too-large",
  );
  check(
    "header rejection body is classified",
    JSON.stringify(await oversized.json()).includes("HEADER_TOO_LARGE"),
  );

  const options = await fetch(`${baseUrl}/constant`, { method: "OPTIONS", headers });
  check("automatic OPTIONS is guarded", options.status === 431);
  const missing = await fetch(`${baseUrl}/missing`, { headers });
  check("fallback is guarded", missing.status === 431);
} catch (error) {
  check(`compiled server boots and serves (${(error as Error).message})`, false);
} finally {
  try {
    stop?.();
  } catch {
    // Best-effort shutdown after a failed assertion.
  }
}

console.log(
  failures === 0
    ? "AOT request guards verified: timeout + header cap enforced (0 failures)."
    : `AOT request-guard verification FAILED (${failures} failures).`,
);
try {
  rmSync(base, { recursive: true, force: true });
} catch {
  // Best-effort cleanup.
}
process.exit(failures === 0 ? 0 : 1);
