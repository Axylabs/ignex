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
  // 1. Scaffold (no install, no git, plain HTTP, no features → minimal app).
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
      "none",
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

  // 2. Offline dependency resolution: link the workspace's installed @ignex/*
  //    scope into the scaffold (the compiled artifact externalizes @ignex/core
  //    and resolves it from node_modules at runtime).
  mkdirSync(join(appDir, "node_modules"), { recursive: true });
  symlinkSync(WORKSPACE_IGNEX, join(appDir, "node_modules", "@ignex"), "dir");

  // 3. AOT compile the scaffold (`ignex build`; the scaffold builds through
  //    the CLI, not a local builder.ts). `start` runs `.ignex/server.js`.
  const build = run(process.execPath, [CLI_ENTRY, "build"], appDir);
  if (build.status !== 0) fail("ignex build exited non-zero", build.stderr + build.stdout);
  if (!existsSync(join(appDir, ".ignex", "server.js"))) {
    fail(".ignex/server.js missing after build", build.stdout + build.stderr);
  }

  // 4. Boot the compiled server and hit /health. The scaffolded env schema
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
      if (match) return match[0]!.replace(/\.$/, "");
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

  const res = await fetch(new URL("/health", base));
  const body = await res.text();
  proc.kill();
  // The scaffold's health route answers plain-text `ok` (JSON `{status:"ok"}`
  // in feature-rich scaffolds) — accept the family.
  if (res.status !== 200 || !/\bok\b/.test(body)) {
    fail(`/health answered ${res.status} ${JSON.stringify(body)} at ${base}`);
  }

  console.log(`scaffold e2e: create → build → boot → /health OK (${base})`);
  process.exit(0);
} finally {
  rmSync(scaffoldDir, { recursive: true, force: true });
}
