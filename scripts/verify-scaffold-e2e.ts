/**
 * Scaffold → AOT build → boot → HTTP round-trip, END TO END, offline-safe.
 *
 * `create-ignex` scaffolds a fresh app; instead of a network `bun install`,
 * the probe reuses the WORKSPACE's installed node_modules (symlinked into the
 * scaffold) so every @ignex/* import resolves to this monorepo's live
 * packages. The scaffold's `builder.ts` then AOT-compiles the app, the
 * compiled server boots on an OS-assigned port, and `/health` must answer
 * 200. This is the gate that proves `ignex create` output is buildable and
 * runnable against the CURRENT workspace state — the piece unit tests of the
 * scaffolder cannot see.
 *
 * Usage:
 *   bun scripts/verify-scaffold-e2e.ts
 *
 * Exits 0 when the scaffold compiles, boots and serves; 1 with the captured
 * build/boot output otherwise.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_ENTRY = join(REPO, "packages", "cli", "src", "index.ts");
// Workspace-installed @ignex/* symlinks (core/compiler/…) — the scaffold's
// runtime resolution target (bun's ancestor walk finds the repo root, but the
// workspace packages live under packages/app/node_modules/@ignex).
const WORKSPACE_IGNEX = join(REPO, "packages", "app", "node_modules", "@ignex");
// Scratch root INSIDE the repo (gitignored, same pattern as `.dx-eval`).
const SCRATCH = join(REPO, ".dx-eval", "scaffold-e2e");

const fail = (message: string, output?: string): never => {
  console.error(`scaffold e2e FAILED — ${message}`);
  if (output) console.error(output);
  process.exit(1);
};

const run = (cmd: string, args: string[], cwd: string) =>
  spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: "pipe" });

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(dirname(SCRATCH), { recursive: true });
const scaffoldDir = mkdtempSync(SCRATCH);
try {
  const enabled = new Set((process.env.SCAFFOLD_FEATURES ?? "middleware").split(","));
  enabled.add("middleware");
  const features = [...enabled].join(",");
  // 1. Scaffold the requested feature bundle through the public CLI.
  const create = run(
    process.execPath,
    [
      CLI_ENTRY,
      "create",
      "probe-app",
      "--root",
      scaffoldDir,
      "--runtime",
      "bun",
      "--pm",
      "bun",
      "--features",
      features,
      "--protocol",
      "http",
      "--no-install",
      "--no-git",
      "--yes",
    ],
    REPO,
  );
  if (create.status !== 0) fail("create-ignex exited non-zero", create.stderr + create.stdout);

  const appDir = join(scaffoldDir, "probe-app");
  if (!existsSync(join(appDir, "ignex.config.mjs"))) {
    fail("scaffold missing ignex.config.mjs", create.stdout);
  }
  writeFileSync(
    join(appDir, "ignex.config.mjs"),
    `export default {
  openApi: {
    title: "Scaffold Probe API",
    version: "1.2.3",
    servers: [{ url: "http://localhost" }],
    transform: (document) => ({ ...document, "x-probe": true })
  },
  sdk: {
    name: "@probe/sdk",
    version: "1.2.3",
    license: "Apache-2.0",
    description: "Fresh-app consumer contract",
    hooks: {
      transformPackageJson: (pkg) => ({ ...pkg, keywords: ["scaffold", "sdk"] }),
      transformFiles: (files) => [...files, { path: "PROBE.md", content: "custom output" }]
    }
  }
};
`,
  );

  // 2. Offline dependency resolution: link the workspace's installed @ignex/*
  //    scope into the scaffold (the compiled artifact externalizes @ignex/core
  //    and resolves it from node_modules at runtime).
  mkdirSync(join(appDir, "node_modules"), { recursive: true });
  symlinkSync(WORKSPACE_IGNEX, join(appDir, "node_modules", "@ignex"), "dir");
  symlinkSync(
    join(REPO, "packages", "compiler", "node_modules", "typebox"),
    join(appDir, "node_modules", "typebox"),
    "dir",
  );

  const appTypes = run(
    process.execPath,
    [join(REPO, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", "tsconfig.json"],
    appDir,
  );
  if (appTypes.status !== 0) {
    fail(`full ${features} scaffold typecheck failed`, appTypes.stderr + appTypes.stdout);
  }

  // 3. AOT compile the scaffold (`ignex build`; the scaffold builds through
  //    the CLI, not a local builder.ts). `start` runs `.ignex/server.js`.
  const build = run(process.execPath, [CLI_ENTRY, "build"], appDir);
  if (build.status !== 0) fail("ignex build exited non-zero", build.stderr + build.stdout);
  if (!existsSync(join(appDir, ".ignex", "server.js"))) {
    fail(".ignex/server.js missing after build", build.stdout + build.stderr);
  }

  const sdk = run(process.execPath, [CLI_ENTRY, "sdk", "--no-build"], appDir);
  if (sdk.status !== 0) fail("ignex sdk exited non-zero", sdk.stderr + sdk.stdout);
  const sdkDir = join(appDir, ".ignex", "sdk");
  const manifest = (await Bun.file(join(sdkDir, "package.json")).json()) as Record<string, unknown>;
  if (
    manifest.name !== "@probe/sdk" ||
    manifest.license !== "Apache-2.0" ||
    !Array.isArray(manifest.keywords)
  ) {
    fail("SDK config/hooks did not reach package.json", JSON.stringify(manifest));
  }
  const spec = (await Bun.file(join(sdkDir, "openapi.json")).json()) as Record<string, unknown>;
  if (
    spec["x-probe"] !== true ||
    (spec.info as { title?: string }).title !== "Scaffold Probe API"
  ) {
    fail("custom OpenAPI document did not reach the SDK", JSON.stringify(spec));
  }
  if (!existsSync(join(sdkDir, "PROBE.md"))) fail("SDK file hook did not emit PROBE.md");

  if (enabled.has("rpc")) {
    const rpcManifest = (await Bun.file(join(appDir, ".ignex", "rpc-manifest.json")).json()) as {
      methods?: Record<string, unknown>;
    };
    if (rpcManifest.methods?.ping === undefined) fail("RPC manifest did not contain ping");
    const realtimeSdk = run(
      process.execPath,
      [CLI_ENTRY, "sdk", "--platform", "realtime", "--no-build", "--out", ".ignex/realtime-sdk"],
      appDir,
    );
    if (realtimeSdk.status !== 0) {
      fail("realtime SDK generation failed", realtimeSdk.stderr + realtimeSdk.stdout);
    }
    for (const artifact of ["rpc.gen.ts", "payloads.gen.ts", "client.gen.ts"]) {
      if (!existsSync(join(appDir, ".ignex", "realtime-sdk", "realtime", artifact))) {
        fail(`realtime SDK artifact missing: ${artifact}`);
      }
    }
  }

  writeFileSync(
    join(appDir, "sdk-consumer.ts"),
    `import { createApiClient } from "./.ignex/sdk/dist/index.js";
const api = createApiClient({ baseUrl: "http://localhost" });
await api["/health"].get();
`,
  );
  const typecheck = run(
    process.execPath,
    [
      join(REPO, "node_modules", "typescript", "bin", "tsc"),
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "false",
      "--module",
      "ESNext",
      "--moduleResolution",
      "bundler",
      "--target",
      "ESNext",
      "--lib",
      "ESNext,DOM",
      "sdk-consumer.ts",
    ],
    appDir,
  );
  if (typecheck.status !== 0)
    fail("generated SDK consumer typecheck failed", typecheck.stderr + typecheck.stdout);

  // 5. Boot the compiled server and hit /health. The scaffolded env schema
  //    validates PORT >= 1 and expects SESSION_SECRET (normally written by
  //    the scaffold's setup flow) — the probe provisions both itself.
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  writeFileSync(join(appDir, ".env"), `SESSION_SECRET=${secret}\n`, "utf8");
  const proc = Bun.spawn([process.execPath, join(".ignex", "server.js")], {
    cwd: appDir,
    env: { ...process.env, PORT: String(port), IGNEX_HTTPS: "0", NODE_ENV: "test" },
    stdout: "pipe",
    stderr: "pipe",
  });

  const base = await (async (): Promise<string> => {
    const deadline = Date.now() + 20_000;
    let buffer = "";
    const decode = new TextDecoder();
    // Drain stdout (the ready line) AND stderr (boot failures print there)
    // so a failed boot surfaces its real error, not an empty buffer.
    const stdoutDone = (async (): Promise<void> => {
      const stdout = proc.stdout.getReader();
      for (;;) {
        const { done, value } = await stdout.read();
        if (done) return;
        buffer += decode.decode(value, { stream: true });
      }
    })();
    const stderrDone = (async (): Promise<void> => {
      const stderr = proc.stderr.getReader();
      for (;;) {
        const { done, value } = await stderr.read();
        if (done) return;
        buffer += decode.decode(value, { stream: true });
      }
    })();
    for (;;) {
      const match = /https?:\/\/\S+:\d+/.exec(buffer);
      const url = match?.[0];
      if (url) return url.replace(/\.$/, "");
      // Fallback: the ready line may print the loopback without scheme.
      if (buffer.includes(`:${port}`)) return `http://127.0.0.1:${port}`;
      const exited = proc.exitCode !== null || proc.signalCode !== null;
      if (exited) {
        await Promise.allSettled([stdoutDone, stderrDone]);
        throw new Error(`server exited before ready (code ${proc.exitCode}):\n${buffer}`);
      }
      if (Date.now() > deadline) throw new Error(`boot timeout:\n${buffer}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  })();

  const res = await fetch(new URL("/health", base), {
    headers: { "x-request-id": "scaffold-e2e-request" },
  });
  const body = await res.text();
  if (res.headers.get("x-request-id") !== "scaffold-e2e-request") {
    fail("requestId plugin did not correlate the scaffolded response");
  }
  // The scaffold's health route answers plain-text `ok` (JSON `{status:"ok"}`
  // in feature-rich scaffolds) — accept the family.
  if (res.status !== 200 || !/\bok\b/.test(body)) {
    fail(`/health answered ${res.status} ${JSON.stringify(body)} at ${base}`);
  }

  if (enabled.has("sessions")) {
    const sessionResponse = await fetch(new URL("/session", base));
    const sessionBody = (await sessionResponse.json()) as { visits?: number };
    if (sessionResponse.status !== 200 || sessionBody.visits !== 1) {
      fail(`session route failed: ${sessionResponse.status} ${JSON.stringify(sessionBody)}`);
    }
  }

  if (enabled.has("metrics")) {
    const metricsResponse = await fetch(new URL("/metrics", base));
    const metricsBody = await metricsResponse.text();
    if (metricsResponse.status !== 200 || !metricsBody.includes("ignex_http_requests_total")) {
      fail(`metrics route failed: ${metricsResponse.status} ${metricsBody}`);
    }
  }

  if (enabled.has("auth")) {
    const credentials = { username: "new-user", password: "a-long-test-password" };
    const post = async (path: string, payload: unknown) => {
      const response = await fetch(new URL(path, base), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { response, data: (await response.json()) as Record<string, unknown> };
    };
    const registered = await post("/auth/register", credentials);
    if (registered.response.status !== 201) {
      fail(`registration failed: ${registered.response.status} ${JSON.stringify(registered.data)}`);
    }
    const login = await post("/auth/login", credentials);
    if (login.response.status !== 200 || typeof login.data.accessToken !== "string") {
      fail(`login failed: ${login.response.status} ${JSON.stringify(login.data)}`);
    }
    const me = await fetch(new URL("/auth/me", base), {
      headers: { authorization: `Bearer ${login.data.accessToken}` },
    });
    const meBody = (await me.json()) as { user?: { roles?: string[] } };
    if (me.status !== 200 || meBody.user?.roles?.includes("user") !== true) {
      fail(`authenticated /me failed: ${me.status} ${JSON.stringify(meBody)}`);
    }
    if (enabled.has("refresh")) {
      const firstRefresh = await post("/auth/refresh", { refreshToken: login.data.refreshToken });
      const replay = await post("/auth/refresh", { refreshToken: login.data.refreshToken });
      if (firstRefresh.response.status !== 200 || replay.response.status !== 401) {
        fail(
          `refresh rotation/replay failed: first=${firstRefresh.response.status} replay=${replay.response.status}`,
        );
      }
    }
  }

  const sdkModule = (await import(join(sdkDir, "dist", "index.js"))) as {
    createApiClient: (options: { baseUrl: string }) => {
      [path: string]: { get: () => Promise<unknown> };
    };
  };
  const api = sdkModule.createApiClient({ baseUrl: base });
  const sdkHealth = await api["/health"]?.get();
  if (!/\bok\b/.test(String(sdkHealth))) {
    fail(`generated SDK /health answered ${JSON.stringify(sdkHealth)}`);
  }
  proc.kill();

  console.log(
    `scaffold e2e: create → build → custom SDK → typecheck → boot → SDK /health OK (${base})`,
  );
  process.exit(0);
} finally {
  rmSync(scaffoldDir, { recursive: true, force: true });
}
