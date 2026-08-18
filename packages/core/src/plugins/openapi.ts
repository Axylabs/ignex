/**
 * @fileoverview OpenAPI plugin — runtime OpenAPI 3.1 docs + Scalar/Swagger-UI.
 *
 * An Elysia-`@elysiajs/openapi`-style docs plugin. Serves two endpoints by
 * default:
 *   - `GET /openapi.json` — the OpenAPI 3.1 document (JSON)
 *   - `GET /openapi`      — a docs UI (Scalar by default, Swagger-UI opt-in)
 *
 * Dual-mode:
 *   - **Interpreted** (`createApp({ router, plugins: [openapi()] })`):
 *     registers real routes via `routes(router)` and generates the document
 *     on demand by introspecting `router.listRoutes()`.
 *   - **AOT/compiled** (plugins from `src/app.config.ts`): `routes()` is never
 *     invoked, so `onRequest` intercepts the two paths and serves the
 *     compiler-generated `openapi.json` artifact (probed from
 *     `.ignex/openapi.json` → `dist/openapi.json`, overridable via
 *     `artifactPath`), falling back to runtime generation when absent.
 *
 * The plugin's own endpoints are hidden from the document both by path
 * exclusion and `detail.hide` (the shared generator skips hidden routes), so
 * the spec never describes the docs endpoints themselves.
 */

import type { IgnexContext } from "../http/context";
import type { IgnexRouter, RouteRegistration } from "../http/router";
import type { IgnexPlugin } from "../lifecycle/plugin";
import {
  generateOpenAPI,
  type OpenAPIDocument,
  type OpenAPIInfo,
  type RouteDefinition,
} from "../openapi";

/** Docs UI providers supported by {@link openapi}. */
export type OpenAPIProvider = "scalar" | "swagger-ui" | null;

/** Options for {@link openapi}. */
export interface OpenAPIOptions {
  /** Docs UI route. Default `/openapi`; `null` disables the UI page. */
  path?: string | null;
  /** OpenAPI JSON spec route. Default `/openapi.json`. */
  specPath?: string;
  /** Docs UI provider. Default `"scalar"`; `null` disables the UI page. */
  provider?: OpenAPIProvider;
  /** Document-level metadata — merged into the `info` block / root. */
  documentation?: {
    title?: string;
    version?: string;
    description?: string;
    tags?: unknown[];
  };
  /** Paths/methods to keep out of the document. */
  exclude?: {
    /** Paths to exclude (exact strings or RegExps). */
    paths?: (string | RegExp)[];
    /** Methods to exclude (lower-cased). Default `["options"]`. */
    methods?: string[];
    /** Exclude static-file-looking paths (last segment has a dot). Default `true`. */
    staticFile?: boolean;
  };
  /** Scalar UI configuration (theme, etc.) — serialized into the page. */
  scalar?: Record<string, unknown>;
  /** Swagger-UI configuration (bundled options). */
  swagger?: Record<string, unknown>;
  /**
   * Compiled `openapi.json` artifact path(s) for AOT apps. Defaults to probing
   * `.ignex/openapi.json` then `dist/openapi.json` (scaffold vs example).
   */
  artifactPath?: string | string[];
}

/** Default artifact locations probed in AOT mode. */
const DEFAULT_ARTIFACT_PATHS = [".ignex/openapi.json", "dist/openapi.json"];

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Scalar docs page — mirrors the pre-plugin `reference.get.ts` example. */
const scalarHtml = (title: string, specUrl: string, scalar: Record<string, unknown>): string => {
  const configuration =
    Object.keys(scalar).length > 0 ? JSON.stringify(scalar).replace(/'/g, "&#39;") : undefined;
  return `<!doctype html>
<html lang="en">
  <head>
    <title>${escapeHtml(title)}</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" data-url="${specUrl}"${
      configuration ? ` data-configuration='${configuration}'` : ""
    }></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;
};

/** Swagger-UI docs page — mirrors Elysia's `swagger-ui` provider. */
const swaggerUiHtml = (
  title: string,
  specUrl: string,
  swagger: Record<string, unknown>,
): string => {
  const options = JSON.stringify({ url: specUrl, dom_id: "#swagger-ui", ...swagger });
  return `<!doctype html>
<html lang="en">
  <head>
    <title>${escapeHtml(title)}</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script>
    <script>window.onload = () => SwaggerUIBundle(${options});</script>
  </body>
</html>`;
};

/** Path parameter names from a Bun-syntax path (`/users/:id` → `["id"]`). */
const paramNamesOf = (path: string): readonly string[] =>
  [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);

/**
 * True when the last path segment carries a file extension (`/assets/app.js`,
 * `/openapi.json`) — the "static file" heuristic used for `exclude.staticFile`.
 */
const isStaticFile = (routePath: string): boolean => {
  const last = routePath.slice(routePath.lastIndexOf("/") + 1);
  return last.includes(".") && !last.endsWith("/");
};

const jsonResponse = (doc: unknown): Response =>
  new Response(JSON.stringify(doc), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const htmlResponse = (html: string): Response =>
  new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });

/**
 * OpenAPI plugin — serves the OpenAPI document + a docs UI.
 *
 * ```ts
 * const app = createApp({
 *   router,
 *   plugins: [openapi({ documentation: { title: "My API", version: "1.0.0" } })],
 * });
 * ```
 *
 * @param options - {@link OpenAPIOptions}.
 * @returns The OpenAPI plugin.
 */
export const openapi = (options: OpenAPIOptions = {}): IgnexPlugin => {
  const {
    path = "/openapi",
    specPath = "/openapi.json",
    provider = "scalar",
    documentation = {},
    exclude,
    scalar = {},
    swagger = {},
    artifactPath,
  } = options;

  let router: IgnexRouter | undefined;
  let cachedSpec: { count: number; doc: OpenAPIDocument } | undefined;
  let artifactCache: OpenAPIDocument | undefined;
  let warnedFallback = false;

  const info: OpenAPIInfo = {
    title: documentation.title ?? "IgnEx API",
    version: documentation.version ?? "0.1.0",
  };
  if (documentation.description !== undefined) info.description = documentation.description;

  const ownPaths = new Set<string>([specPath]);
  if (typeof path === "string") ownPaths.add(path);

  const excludedMethods = new Set((exclude?.methods ?? ["options"]).map((m) => m.toLowerCase()));

  const isExcludedPath = (routePath: string): boolean => {
    if (ownPaths.has(routePath)) return true;
    if (exclude?.staticFile !== false && isStaticFile(routePath)) return true;
    for (const pattern of exclude?.paths ?? []) {
      if (typeof pattern === "string" ? pattern === routePath : pattern.test(routePath)) {
        return true;
      }
    }
    return false;
  };

  /** Map runtime route registrations onto the shared `RouteDefinition` contract. */
  const toRouteDefinitions = (regs: readonly RouteRegistration[]): RouteDefinition[] =>
    regs
      .filter((reg) => !excludedMethods.has(reg.method.toLowerCase()))
      .filter((reg) => !isExcludedPath(reg.path))
      .map((reg) => {
        const def: RouteDefinition = {
          method: reg.method,
          path: reg.path,
          paramNames: paramNamesOf(reg.path),
          usesBody: reg.schema?.body != null,
        };
        if (reg.schema) {
          def.schema = {
            body: reg.schema.body,
            headers: reg.schema.headers,
            query: reg.schema.query,
            params: reg.schema.params,
            cookie: reg.schema.cookie,
            response: reg.schema.response,
          };
        }
        if (reg.detail) def.detail = reg.detail as Record<string, unknown>;
        return def;
      });

  /** Build the runtime document from the router's registered routes (cached). */
  const buildSpec = (): OpenAPIDocument => {
    if (!router) {
      // AOT/no-router: nothing to enumerate at runtime — the compiled
      // artifact (readArtifact) is the source of truth.
      return generateOpenAPI(info, []);
    }
    const regs = router.listRoutes();
    if (cachedSpec && cachedSpec.count === regs.length) return cachedSpec.doc;
    const doc = generateOpenAPI(info, toRouteDefinitions(regs));
    if (documentation.tags !== undefined) doc.tags = documentation.tags;
    cachedSpec = { count: regs.length, doc };
    return doc;
  };

  /** Locate + parse the compiled `openapi.json` artifact (AOT mode). */
  const readArtifact = async (): Promise<OpenAPIDocument | undefined> => {
    if (artifactCache) return artifactCache;
    if (typeof Bun === "undefined") return undefined;
    const candidates = (
      Array.isArray(artifactPath) ? artifactPath : artifactPath ? [artifactPath] : []
    ).concat(DEFAULT_ARTIFACT_PATHS);
    for (const candidate of candidates) {
      try {
        const file = Bun.file(candidate);
        if (await file.exists()) {
          artifactCache = (await file.json()) as OpenAPIDocument;
          return artifactCache;
        }
      } catch {
        // Corrupt/missing artifact — try the next candidate.
      }
    }
    return undefined;
  };

  const specResponse = (): Response => jsonResponse(buildSpec());

  const uiResponse = (): Response =>
    htmlResponse(
      provider === "swagger-ui"
        ? swaggerUiHtml(info.title, specPath, swagger)
        : scalarHtml(info.title, specPath, scalar),
    );

  /** Interpreted mode — register the spec + docs routes on the router. */
  const registerRoutes = (target: IgnexRouter): void => {
    router = target;
    target.get(specPath, () => specResponse(), { detail: { hide: true } });
    if (typeof path === "string" && provider !== null) {
      target.get(path, () => uiResponse(), { detail: { hide: true } });
    }
  };

  /**
   * AOT fallback — intercept the two paths when no router exists. Deliberately
   * synchronous on the pass-through path (interpreted mode returns `ctx`
   * without a Promise; unmatched AOT paths return `ctx` too). Only the first
   * artifact read is async.
   */
  const onRequest = (
    ctx: IgnexContext,
  ): IgnexContext | Response | Promise<IgnexContext | Response> => {
    if (router) return ctx;
    const { pathname } = ctx.url;
    if (pathname === specPath) {
      if (artifactCache) return jsonResponse(artifactCache);
      return readArtifact().then((artifact) => {
        if (artifact) return jsonResponse(artifact);
        if (!warnedFallback) {
          warnedFallback = true;
          console.warn(
            "[ignex] openapi: no compiled openapi.json artifact found; serving an empty document. " +
              "Set `artifactPath` (AOT) or use a router (interpreted) so routes can be enumerated.",
          );
        }
        return specResponse();
      });
    }
    if (typeof path === "string" && pathname === path && provider !== null) {
      return uiResponse();
    }
    return ctx;
  };

  return {
    name: "openapi",
    routes: registerRoutes,
    onRequest,
  };
};
