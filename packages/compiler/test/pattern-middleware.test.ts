/**
 * Compiled pipeline test for PATTERN-SCOPED global middleware.
 *
 * The interpreted path is covered in packages/core (plugin.test.ts); this
 * test proves the COMPILED server honors `IgnexPlugin.pattern`: a plugin
 * scoped to "/api/*" must run for API routes and be skipped entirely for
 * other paths. The compiled server boots in-process (the generated module
 * starts Bun.serve on import; PORT env keeps parallel builds from colliding).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAsync } from "../src/index";
import { type FixtureLayout, fixturePath, materializeFixture } from "./helpers";

const origPort = process.env.PORT;
afterEach(() => {
  if (origPort === undefined) delete process.env.PORT;
  else process.env.PORT = origPort;
});

describe("compiled pattern-scoped middleware", () => {
  // The generated module calls `Bun.serve` at import time; vitest workers may
  // run under Node, where that import cannot succeed.
  const hasBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

  it.runIf(hasBun)(
    "runs the plugin only for matching pathnames (build → boot → serve)",
    async () => {
      const layout: FixtureLayout = materializeFixture("pattern-mw");
      const result = await buildAsync({
        routesDir: layout.routesDir,
        outDir: layout.outDir,
        outFile: "server.js",
        appConfig: fixturePath("pattern-mw", "app.config.ts"),
        minify: false,
        sourceMap: false,
        incremental: false,
        generateTypes: false,
        generateOpenAPI: false,
        generateClient: false,
        precompileValidators: false,
        precompileSerializers: false,
      });
      expect(result.errors).toHaveLength(0);

      const serverPath = join(layout.outDir, "server.js");
      writeFileSync(serverPath, result.code);
      process.env.PORT = String(32700 + Math.floor(Math.random() * 200));

      const { default: server } = (await import(serverPath)) as {
        default: { port: number; stop(): void };
      };
      const base = `http://localhost:${server.port}`;
      try {
        const apiRes = await fetch(`${base}/api`);
        expect(apiRes.status).toBe(200);
        expect(apiRes.headers.get("x-scoped")).toBe("yes");

        const otherRes = await fetch(`${base}/other`);
        expect(otherRes.status).toBe(200);
        expect(otherRes.headers.get("x-scoped")).toBeNull();
      } finally {
        server.stop();
      }
    },
  );
});
