/**
 * @fileoverview Knowledge transfer (KT) — a living "how this app works" doc.
 *
 * The debug dashboard's KT page is generated from real artifacts, never from
 * prose that drifts: the AOT route map (manifest.json), the interpreted
 * router's registrations, registered plugins, lifecycle stage inventory, the
 * environment, and the published-SDK metadata. Every developer opening the
 * dashboard sees exactly what this deployment does — no onboarding doc needed.
 */

import type { IgnexRouter, RouteRegistration } from "../http/router";
import type {
  AppKnowledge,
  KnowledgeOptions,
  KnowledgePlugin,
  KnowledgeRoute,
  KnowledgeSdk,
  KnowledgeStage,
  SpanKind,
} from "./types";

/** Human-readable descriptions for the built-in plugin factories. */
const KNOWN_PLUGINS: Record<string, string> = {
  auth: "Authentication module (JWT / bearer / basic) with per-route guards.",
  authModule: "Configurable auth module (JWT, basic, bearer) + middleware hooks.",
  basicAuthPlugin: "HTTP Basic authentication.",
  bearerAuthPlugin: "Bearer-token authentication.",
  jwtAuthPlugin: "JWT (HS256/Ed25519) authentication.",
  optionalAuthPlugin:
    "Optional authentication — sets the user when credentials are valid, never rejects.",
  compression: "Response compression (gzip/deflate/br) with content negotiation.",
  cors: "Cross-Origin Resource Sharing (wildcard or configured origins).",
  csrf: "CSRF token verification for state-changing requests.",
  logger: "Structured access logging (pino) with sensitive-header redaction.",
  nativePreflight: "Native (Rust) request pre-flight: CORS preflight + URL/header/query limits.",
  openapi: "OpenAPI 3.1 spec (`/openapi.json`) + docs UI (`/openapi`).",
  rateLimit: "Sliding-window / token-bucket rate limiting per client.",
  rbac: "Role-based access control (roles, permissions, guard chains).",
  security: "Security headers on every response.",
  session: "Signed-cookie sessions (stateless or store-backed) with rolling expiry.",
  debugbar: "Developer debug dashboard (traces, waterfall, errors, replay, system profile, KT).",
  nova: "Typed realtime transport (@ignex/nova): FlatBuffer pub/sub over Bun WebSockets, Rust FFI serializer, NATS cluster sync.",
};

const spanKindNames: Record<SpanKind, string> = {
  request: "the request itself",
  lifecycle: "framework lifecycle stages",
  db: "database queries / transactions",
  cache: "cache operations",
  http: "outbound HTTP calls",
  render: "template rendering / static file serving",
  auth: "authentication / sessions / security checks",
  custom: "application code",
  error: "failed operations",
};

/** Human summary of the context members a route handler touches. */
const usageSummary = (usage: Record<string, boolean> | undefined): string[] => {
  if (!usage) return [];
  const map: Array<[string, string]> = [
    ["body", "reads the request body"],
    ["params", "reads route params"],
    ["query", "reads the query string"],
    ["headers", "reads request headers"],
    ["state", "uses per-request state"],
    ["cookie", "reads/writes cookies"],
    ["set", "mutates response headers/status"],
    ["json", "returns JSON"],
    ["text", "returns text"],
    ["html", "returns HTML"],
    ["stream", "streams a response"],
    ["redirect", "redirects"],
    ["file", "accepts file uploads"],
    ["sendFile", "serves files"],
    ["proxy", "proxies requests"],
    ["forward", "forwards requests"],
    ["cache", "uses the response cache"],
    ["loader", "uses DataLoaders (batching)"],
    ["req", "reads the raw request"],
    ["url", "reads the request URL"],
    ["server", "uses the server handle"],
  ];
  const out: string[] = [];
  for (const [key, text] of map) {
    if (usage[key]) out.push(text);
  }
  return out;
};

const envSummary = (): Record<string, string> => {
  const keys = ["NODE_ENV", "PORT", "IGNEX_DEBUG", "IGNEX_NATIVE", "DATABASE_URL"];
  const out: Record<string, string> = {};
  for (const key of keys) {
    if (process.env[key] !== undefined) out[key] = process.env[key] as string;
  }
  return out;
};

const runtimeInfo = (): AppKnowledge["runtime"] => {
  const bun = (globalThis as { Bun?: { version?: string } }).Bun;
  return {
    bunVersion: bun?.version ?? "unknown",
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    nodeEnv: process.env.NODE_ENV ?? "development",
    startedAt: Date.now(),
    uptimeSec: Math.round(process.uptime()),
  };
};

/** Probe a manifest.json artifact (AOT route map). */
const readManifestRoutes = async (
  paths: readonly string[],
): Promise<Array<Record<string, unknown>> | null> => {
  if (typeof Bun === "undefined") return null;
  for (const candidate of paths) {
    try {
      const file = Bun.file(candidate);
      if (await file.exists()) {
        const doc = (await file.json()) as { routes?: Array<Record<string, unknown>> };
        if (Array.isArray(doc.routes)) return doc.routes;
      }
    } catch {
      // corrupt/missing artifact — try the next candidate
    }
  }
  return null;
};

const routeFromManifest = (r: Record<string, unknown>): KnowledgeRoute | null => {
  const method = String(r.method ?? "");
  const path = String(r.path ?? "");
  if (!method || !path) return null;
  return {
    method,
    path,
    file: r.file ? String(r.file) : null,
    description:
      r.responseType === "json"
        ? "Returns JSON."
        : r.isConstantResponse === true
          ? "Serves a constant (compiled-in) response."
          : r.responseType === "html"
            ? "Returns HTML."
            : r.responseType === "text"
              ? "Returns plain text."
              : "Handles the request.",
    usage: usageSummary((r.usage as Record<string, boolean> | undefined) ?? undefined),
    isConstant: r.isConstantResponse === true,
    hooks: Array.isArray(r.hooks) ? (r.hooks as string[]) : [],
  };
};

const routeFromRegistration = (r: RouteRegistration): KnowledgeRoute => ({
  method: r.method,
  path: r.path,
  file: null,
  description: r.detail?.summary ? String(r.detail.summary) : "Runtime-registered route.",
  usage: r.schema
    ? [
        ...(r.schema.body ? ["validates the request body"] : []),
        ...(r.schema.query ? ["validates the query string"] : []),
        ...(r.schema.params ? ["validates route params"] : []),
        ...(r.schema.headers ? ["validates request headers"] : []),
      ]
    : [],
  isConstant: false,
  hooks: [],
});

/** Probe the published-SDK metadata. */
const readSdk = async (paths: readonly string[]): Promise<KnowledgeSdk | null> => {
  if (typeof Bun === "undefined") return null;
  for (const candidate of paths) {
    try {
      const file = Bun.file(candidate);
      if (!(await file.exists())) continue;
      const pkg = (await file.json()) as {
        name?: string;
        version?: string;
        files?: string[];
      };
      if (!pkg.name) continue;
      return {
        name: pkg.name,
        version: pkg.version ?? "0.0.0",
        location: candidate,
        files: Array.isArray(pkg.files) ? pkg.files.slice(0, 12) : [],
        // Enriched by the debugbar plugin with real git-tag state (see
        // `serveSdks` / the ClientRegistry) — a raw probe reports unknown.
        gitTags: [],
        published: "unknown",
      };
    } catch {
      // skip
    }
  }
  return null;
};

const defaultManifestPaths = [".ignex/manifest.json", "dist/manifest.json"];
const defaultSdkPaths = ["dist/sdk/package.json", ".ignex/sdk/package.json", "dist/sdk.json"];

/**
 * Build the app knowledge snapshot. Async only because AOT artifacts are read
 * from disk; the interpreted route map and all runtime facts are synchronous.
 */
export const buildAppKnowledge = async (
  options: KnowledgeOptions & { router?: IgnexRouter },
): Promise<AppKnowledge> => {
  const { router, serviceName, version = "0.0.0", lifecycle = {}, plugins = [] } = options;
  const manifestPaths = options.manifestPaths?.length
    ? options.manifestPaths
    : defaultManifestPaths;
  const sdkPaths = options.sdkPaths?.length ? options.sdkPaths : defaultSdkPaths;

  let routes: KnowledgeRoute[] = [];
  if (router) {
    routes = router.listRoutes().map(routeFromRegistration);
  } else {
    const manifestRoutes = await readManifestRoutes(manifestPaths);
    routes = (manifestRoutes ?? [])
      .map(routeFromManifest)
      .filter((r): r is KnowledgeRoute => r !== null)
      .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  }

  const pluginRows: KnowledgePlugin[] = plugins.map((name) => ({
    name,
    description: KNOWN_PLUGINS[name] ?? "Custom application plugin.",
  }));

  const stageRows: KnowledgeStage[] = Object.entries(lifecycle).map(([name, hookCount], index) => ({
    name,
    hookCount,
    order: index,
  }));

  return {
    serviceName,
    version,
    debugMode: true,
    environment: envSummary(),
    runtime: runtimeInfo(),
    routes,
    plugins: pluginRows,
    lifecycle: stageRows,
    spanKinds: Object.keys(spanKindNames) as SpanKind[],
    sdk: await readSdk(sdkPaths),
    notes: [],
  };
};

/** Render the knowledge snapshot as Markdown for the KT page. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear markdown section per feature — branchy by nature
export const formatKnowledgeMarkdown = (knowledge: AppKnowledge): string => {
  const lines: string[] = [];
  lines.push(`# ${knowledge.serviceName} — how this app works`);
  lines.push("");
  lines.push(
    `> Auto-generated from this deployment: ${knowledge.routes.length} routes, ` +
      `${knowledge.plugins.length} plugin(s), ${knowledge.lifecycle.length} lifecycle stage(s). ` +
      `Debug mode: **on**.`,
  );
  lines.push("");

  lines.push("## Request anatomy");
  lines.push("");
  lines.push(
    "Every request flows: `Bun.serve` native router → context → lifecycle stages " +
      "(`start` → `request` → `parse` → `transform` → `beforeHandle`) → handler → " +
      "(`afterHandle` → `mapResponse`) → response. A pre-stage may halt the chain " +
      "with a response (auth, rate limits, CORS). Errors run the `error` stage. " +
      "The debugbar records each stage + every `ctx.debug` span as a waterfall row.",
  );
  lines.push("");

  lines.push("## Plugins");
  lines.push("");
  if (knowledge.plugins.length === 0) {
    lines.push("_None registered._");
  } else {
    lines.push("| Plugin | What it does |");
    lines.push("| --- | --- |");
    for (const p of knowledge.plugins) lines.push(`| \`${p.name}\` | ${p.description} |`);
  }
  lines.push("");

  lines.push("## Lifecycle stages");
  lines.push("");
  if (knowledge.lifecycle.length === 0) {
    lines.push("_No lifecycle hooks registered._");
  } else {
    lines.push("| # | Stage | Hooks |");
    lines.push("| --- | --- | --- |");
    for (const s of [...knowledge.lifecycle].sort((a, b) => a.order - b.order)) {
      lines.push(`| ${s.order} | \`${s.name}\` | ${s.hookCount} |`);
    }
  }
  lines.push("");

  lines.push("## Routes");
  lines.push("");
  if (knowledge.routes.length === 0) {
    lines.push(
      "_No routes discovered (no manifest.json artifact and no router). Run `ignex build`._",
    );
  } else {
    lines.push("| Method | Path | Source | Usage |");
    lines.push("| --- | --- | --- | --- |");
    for (const r of knowledge.routes) {
      const usage = r.usage.length > 0 ? r.usage.join(", ") : "—";
      const source = r.file ?? r.description;
      lines.push(`| ${r.method} | \`${r.path}\` | ${source} | ${usage} |`);
    }
  }
  lines.push("");

  lines.push("## Span kinds you can trace");
  lines.push("");
  for (const kind of knowledge.spanKinds) {
    lines.push(`- \`${kind}\` — ${spanKindNames[kind]}.`);
  }
  lines.push("");

  lines.push("## Published SDK");
  lines.push("");
  if (knowledge.sdk) {
    lines.push(
      `- **${knowledge.sdk.name}@${knowledge.sdk.version}** at \`${knowledge.sdk.location}\``,
    );
    if (knowledge.sdk.files.length > 0) {
      lines.push(`- Files: ${knowledge.sdk.files.map((f) => `\`${f}\``).join(", ")}`);
    }
    if (knowledge.sdk.gitTags.length > 0) {
      lines.push(
        `- Git tags: ${knowledge.sdk.gitTags.map((t) => `\`${t}\``).join(", ")}` +
          ` (${knowledge.sdk.published === "tagged" ? "tagged ✓" : "local only"})`,
      );
    }
    lines.push("- Generated with `ignex sdk`; frontend teams install it and get typed endpoints.");
  } else {
    lines.push(
      "_No published SDK detected. Run `ignex sdk` (or set `debugbar({ sdkPaths })`) to generate one._",
    );
  }
  lines.push("");

  lines.push("## Environment");
  lines.push("");
  lines.push("| Key | Value |");
  lines.push("| --- | --- |");
  lines.push(
    `| Runtime | Bun ${knowledge.runtime.bunVersion} on ${knowledge.runtime.platform}/${knowledge.runtime.arch} (pid ${knowledge.runtime.pid}) |`,
  );
  for (const [key, value] of Object.entries(knowledge.environment)) {
    lines.push(`| \`${key}\` | \`${value}\` |`);
  }
  lines.push("");

  if (knowledge.notes.length > 0) {
    lines.push("## Notes");
    lines.push("");
    for (const note of knowledge.notes) lines.push(`- ${note}`);
    lines.push("");
  }

  return lines.join("\n");
};
