#!/usr/bin/env bun
/**
 * Standalone OpenAPI + typed-client generator.
 *
 * Discovers route files, loads each module's exported schema, and emits an
 * OpenAPI 3.1 document using the compiler's canonical `generateOpenApi`
 * (route parsing via `parseRouteFilename`). The hey-api client generation
 * (`@hey-api/openapi-ts`) then turns that document into a typed SDK under
 * {@link CLIENT_OUT}.
 *
 * Delegating to `@ignus/compiler` keeps this script's output from ever
 * drifting from `ignus build`'s `openapi.json`.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CompilerOptions, RouteDef } from "@ignus/compiler";
import { generateOpenApi, parseRouteFilename } from "@ignus/compiler";

const ROUTES_DIR = process.env.ROUTES_DIR || "./packages/app/src/routes";
const OPENAPI_OUT = process.env.OPENAPI_OUT || "./packages/app/dist/openapi.json";
const CLIENT_OUT = process.env.CLIENT_OUT || "./packages/app/src/client";

async function loadRouteSchema(absPath: string) {
  try {
    const mod: any = await import(pathToFileURL(absPath).href);

    return mod?.schema ?? mod?.default?.schema ?? undefined;
  } catch (err) {
    console.warn(`[openapi] Skipped ${absPath}: ${(err as Error).message}`);
    return undefined;
  }
}

async function main() {
  const glob = new Bun.Glob("**/*.{ts,tsx,js,mjs,jsx}");

  const files: string[] = [];

  for await (const file of glob.scan({
    cwd: ROUTES_DIR,
    onlyFiles: true,
  })) {
    if (file.endsWith(".d.ts")) continue;
    files.push(file);
  }

  const routes: RouteDef[] = [];

  for (const file of files) {
    const parsed = parseRouteFilename(file);

    if (!parsed || parsed.method === "ALL") continue;

    const abs = join(process.cwd(), ROUTES_DIR, file);
    const schema = await loadRouteSchema(abs);

    // Shape the loaded route module into the minimal RouteDef surface the
    // canonical OpenAPI generator reads; everything else is derived there.
    routes.push({
      source: {
        method: parsed.method,
        path: parsed.path,
        paramNames: parsed.paramNames,
      },
      analysis: {
        config: {},
        usage: { body: Boolean(schema?.body) },
      },
      decisions: { schemaDoc: schema as Record<string, unknown> | undefined },
    } as unknown as RouteDef);
  }

  const openapi = generateOpenApi(routes, { serviceName: "ignus" } as CompilerOptions);

  mkdirSync(dirname(OPENAPI_OUT), { recursive: true });

  await Bun.write(OPENAPI_OUT, JSON.stringify(openapi, null, 2));

  console.log(`[openapi] Wrote ${OPENAPI_OUT}`);

  const result = Bun.spawnSync(
    [
      "bunx",
      "@hey-api/openapi-ts@latest",
      "--input",
      OPENAPI_OUT,
      "--output",
      CLIENT_OUT,
      "--client",
      "@hey-api/client-fetch",
    ],
    {
      stdio: ["inherit", "inherit", "inherit"],
    },
  );

  if (result.exitCode !== 0) {
    console.warn("[heyapi] Client generation failed. Check @hey-api/openapi-ts install.");
  } else {
    console.log(`[heyapi] Generated client in ${CLIENT_OUT}`);
  }
}

await main();
