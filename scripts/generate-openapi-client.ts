#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

const ROUTES_DIR = process.env.ROUTES_DIR || "./packages/app/src/routes";
const OPENAPI_OUT = process.env.OPENAPI_OUT || "./packages/app/dist/openapi.json";
const CLIENT_OUT = process.env.CLIENT_OUT || "./packages/app/src/client";

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ALL"]);

function parseRouteFile(file: string) {
  const ext = extname(file);
  const name = basename(file, ext);
  const parts = name.split(".");

  let method = "GET";
  let routeName = name;

  const last = parts.at(-1);

  if (last && HTTP_METHODS.has(last.toUpperCase())) {
    method = last.toUpperCase();
    routeName = parts.slice(0, -1).join(".");
  }

  const dir = dirname(file);

  let routePath = `/${join(dir, routeName).replace(/\\/g, "/")}`;

  if (routePath.endsWith("/index")) {
    routePath = routePath.slice(0, -5) || "/";
  }

  routePath = routePath
    .replace(/\[(\.\.\.[^\]]+)\]/g, (_, raw) => `*${raw.slice(3)}`)
    .replace(/\[([^\]]+)\]/g, (_, p) => `:${p}`);

  return {
    method,
    path: routePath,
  };
}

function toOpenApiPath(path: string) {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\*([A-Za-z0-9_]+)/g, "{$1}");
}

function isJsonSchema(value: unknown): boolean {
  return typeof value === "object" && value !== null && !("~standard" in value);
}

function schemaToParameters(schema: any, location: "path" | "query") {
  if (!isJsonSchema(schema) || !schema.properties) {
    return [];
  }

  const required = new Set<string>(schema.required ?? []);

  return Object.entries(schema.properties).map(([name, propSchema]) => ({
    name,
    in: location,
    required: location === "path" ? true : required.has(name),
    schema: propSchema,
  }));
}

function pickResponseSchema(responseSchema: any) {
  if (!responseSchema) return undefined;

  if (isJsonSchema(responseSchema)) {
    if (responseSchema.type || responseSchema.properties || responseSchema.$ref) {
      return responseSchema;
    }
  }

  return responseSchema[200] ?? responseSchema["200"] ?? Object.values(responseSchema)[0];
}

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

  const paths: Record<string, Record<string, unknown>> = {};

  for (const file of files) {
    const parsed = parseRouteFile(file);

    if (!parsed || parsed.method === "ALL") continue;

    const abs = join(process.cwd(), ROUTES_DIR, file);
    const schema = await loadRouteSchema(abs);

    const openApiPath = toOpenApiPath(parsed.path);
    const method = parsed.method.toLowerCase();

    const operation: Record<string, unknown> = {
      operationId: `${method}_${openApiPath.replace(/[{}/]/g, "_")}`,
      responses: {
        200: {
          description: "Successful response",
        },
      },
    };

    const parameters: unknown[] = [];

    if (schema?.params) {
      parameters.push(...schemaToParameters(schema.params, "path"));
    }

    if (schema?.query) {
      parameters.push(...schemaToParameters(schema.query, "query"));
    }

    if (parameters.length) {
      operation.parameters = parameters;
    }

    if (schema?.body && isJsonSchema(schema.body)) {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: schema.body,
          },
        },
      };
    }

    const responseSchema = pickResponseSchema(schema?.response);

    if (responseSchema && isJsonSchema(responseSchema)) {
      operation.responses = {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: responseSchema,
            },
          },
        },
      };
    }

    paths[openApiPath] ??= {};
    paths[openApiPath][method] = operation;
  }

  const openapi = {
    openapi: "3.1.0",
    info: {
      title: "Flux API",
      version: "1.0.0",
    },
    paths,
  };

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
