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
 *     `artifactPath`), falling back to runtime generation when absent. The
 *     NEWEST artifact among all candidates wins (keyed by mtime), so dev-mode
 *     regeneration is always served — a stale `dist` build never shadows the
 *     fresh `.ignex` artifact the watcher just produced, and no restart is
 *     needed to pick up a regenerated file.
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
  /**
   * `Content-Security-Policy` for the docs UI page. The default allows the
   * docs CDN bundles (Scalar / Swagger-UI) while keeping everything else
   * same-origin. The `security()` plugin respects an explicitly-set CSP.
   */
  contentSecurityPolicy?: string;
}

/**
 * Default Content-Security-Policy for the docs UI page: permits the docs CDN
 * bundles (Scalar via jsdelivr, Swagger-UI via unpkg) and inline styles/scripts
 * they need, while keeping everything else same-origin.
 */
const DEFAULT_DOCS_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline' https:; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";

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
  [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1] ?? "").filter(Boolean);

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

const htmlResponse = (html: string, contentSecurityPolicy: string): Response =>
  new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": contentSecurityPolicy,
    },
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
    contentSecurityPolicy = DEFAULT_DOCS_CSP,
  } = options;

  let router: IgnexRouter | undefined;
  let cachedSpec: { count: number; doc: OpenAPIDocument } | undefined;
  /** Artifact cache keyed by (path, mtimeMs) so a regenerated file invalidates it. */
  let artifactCache: { path: string; mtimeMs: number; doc: OpenAPIDocument } | undefined;
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

  /** All artifact candidates, most-specific first (explicit overrides win ties). */
  const candidatePaths = (): string[] =>
    (Array.isArray(artifactPath) ? artifactPath : artifactPath ? [artifactPath] : []).concat(
      DEFAULT_ARTIFACT_PATHS,
    );

  /**
   * Locate + parse the compiled `openapi.json` artifact (AOT mode).
   *
   * Probes EVERY candidate and serves the NEWEST by mtime — in dev, the
   * watcher regenerates the artifact into the compiler's outDir (`.ignex`)
   * while an older `dist` build may still exist, so "first found" would serve
   * stale routes forever. The cache is keyed by `(path, mtimeMs)`, so a
   * regenerated artifact invalidates it on the next request without a restart.
   */
  const readArtifact = async (): Promise<OpenAPIDocument | undefined> => {
    if (typeof Bun === "undefined") return undefined;

    let newest: { path: string; mtimeMs: number } | undefined;
    for (const candidate of candidatePaths()) {
      try {
        const file = Bun.file(candidate);
        if (!(await file.exists())) continue;
        const mtimeMs = file.lastModified;
        if (!newest || mtimeMs > newest.mtimeMs) newest = { path: candidate, mtimeMs };
      } catch {
        // Unreadable candidate — try the next.
      }
    }
    if (!newest) return undefined;

    // Serve the cached parse when the newest file is unchanged.
    if (
      artifactCache &&
      artifactCache.path === newest.path &&
      artifactCache.mtimeMs === newest.mtimeMs
    ) {
      return artifactCache.doc;
    }

    try {
      const doc = (await Bun.file(newest.path).json()) as OpenAPIDocument;
      artifactCache = { path: newest.path, mtimeMs: newest.mtimeMs, doc };
      return doc;
    } catch {
      return undefined;
    }
  };

  const specResponse = (): Response => jsonResponse(buildSpec());

  const uiResponse = (): Response =>
    htmlResponse(
      provider === "swagger-ui"
        ? swaggerUiHtml(info.title, specPath, swagger)
        : scalarHtml(info.title, specPath, scalar),
      contentSecurityPolicy,
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
      // Always re-validate through the mtime-keyed cache: in dev the watcher
      // regenerates the artifact while the process may stay alive, so a stale
      // per-process cache would keep serving old routes. The stat is cheap
      // (no file read on a hit); the docs endpoint is not a hot path.
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
