/**
 * @fileoverview Knowledge transfer (KT) — a living "how this app works" doc.
 *
 * The debug dashboard's KT page is generated from real artifacts, never from
 * prose that drifts: the AOT route map (manifest.json), the interpreted
 * router's registrations, registered plugins, lifecycle stage inventory, the
 * environment, the published-SDK metadata, the project layout on disk
 * ("where things live"), the repository's markdown docs (the documentation
 * inventory), and the DB activity actually observed across retained request
 * traces. Every developer opening the dashboard sees exactly what this
 * deployment does and where everything lives — no onboarding doc needed.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { IgnexRouter, RouteRegistration } from "../http/router";
import type {
  AppKnowledge,
  KnowledgeArea,
  KnowledgeDbAction,
  KnowledgeDoc,
  KnowledgeOptions,
  KnowledgePlugin,
  KnowledgeRoute,
  KnowledgeSdk,
  KnowledgeStage,
  RequestTrace,
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
const defaultDocsPaths = ["docs", "."];

/**
 * Build a `"METHOD /path"` → repo-relative source-file index from the AOT
 * manifest artifact(s). Powers the requests API's `sourceFile` so a trace can
 * point straight at `src/routes/users/[id].get.ts` without any sourcemap.
 * Pure async probe; missing manifests yield an empty index.
 */
export const buildRouteFileIndex = async (
  paths: readonly string[],
): Promise<ReadonlyMap<string, string>> => {
  const candidates = paths.length > 0 ? paths : defaultManifestPaths;
  const routes = await readManifestRoutes(candidates);
  const index = new Map<string, string>();
  if (!routes) return index;
  for (const r of routes) {
    const route = routeFromManifest(r);
    if (route?.file) index.set(`${route.method} ${route.path}`, route.file);
  }
  return index;
};

// ── DB activity (what the app actually does to the database) ────────────────

/** Collapse a SQL statement into a stable pattern: literals → `?`. */
const normalizeSql = (sql: string): string =>
  sql
    .replace(/'(?:[^']|'')*'/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);

/** Leading SQL keyword, uppercased (`SELECT`, `INSERT`, …). */
const sqlActionOf = (sql: string): string => {
  const m =
    /^\s*(select|insert|update|delete|replace|create|alter|drop|truncate|begin|commit|rollback|pragma|with)\b/i.exec(
      sql,
    );
  return (m?.[1] ?? "SQL").toUpperCase();
};

/** First table referenced by FROM/INTO/UPDATE/JOIN/TABLE, when parseable. */
const sqlTableOf = (sql: string): string | null => {
  const m = /\b(?:from|into|update|join|table)\s+"?([a-zA-Z_][\w.$]*)"?/i.exec(sql);
  return m?.[1] ?? null;
};

/** Cap on distinct statements listed per route cell + actions kept overall. */
const MAX_DB_ACTIONS = 25;
const MAX_ROUTES_PER_ACTION = 6;

/**
 * Aggregate every `db` span across the retained traces into normalized
 * statement patterns with call counts, total time and the routes that ran
 * them. Pure — the trace store stays untouched.
 */
export const summarizeDbActivity = (traces: readonly RequestTrace[]): KnowledgeDbAction[] => {
  interface Group {
    action: string;
    table: string | null;
    statement: string;
    calls: number;
    totalMs: number;
    routes: Set<string>;
  }
  const groups = new Map<string, Group>();
  for (const trace of traces) {
    const route = trace.route || trace.path;
    for (const span of trace.spans) {
      if (span.kind !== "db") continue;
      const statement = normalizeSql(span.name);
      if (statement === "") continue;
      let group = groups.get(statement);
      if (!group) {
        group = {
          action: sqlActionOf(span.name),
          table: sqlTableOf(span.name),
          statement,
          calls: 0,
          totalMs: 0,
          routes: new Set(),
        };
        groups.set(statement, group);
      }
      group.calls += 1;
      group.totalMs += span.durationMs;
      if (group.routes.size < MAX_ROUTES_PER_ACTION) group.routes.add(route);
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.calls - a.calls || b.totalMs - a.totalMs)
    .slice(0, MAX_DB_ACTIONS)
    .map((g) => ({
      action: g.action,
      table: g.table,
      statement: g.statement,
      calls: g.calls,
      totalMs: Math.round(g.totalMs * 10) / 10,
      routes: [...g.routes],
    }));
};

// ── Project map ("where things live") ────────────────────────────────────────

/** Conventional ignex app areas, probed at `<root>/` then `<root>/src/`. */
const AREA_DEFS: ReadonlyArray<{
  readonly name: string;
  readonly dirs: readonly string[];
  readonly description: string;
}> = [
  {
    name: "routes",
    dirs: ["src/routes", "routes"],
    description:
      "One file per endpoint — the filename IS the URL (`users/[id].get.ts` → GET /users/:id). Start reading here.",
  },
  {
    name: "models",
    dirs: ["src/models", "models"],
    description: "Data models / schemas — the shape of your domain objects.",
  },
  {
    name: "middleware",
    dirs: ["src/middleware", "middleware"],
    description: "Cross-cutting request middleware (auth checks, logging, …).",
  },
  {
    name: "hooks",
    dirs: ["src/hooks", "hooks"],
    description: "Lifecycle hooks that run around every request.",
  },
  {
    name: "views",
    dirs: ["src/views", "views"],
    description: "HTML templates rendered server-side.",
  },
  {
    name: "config",
    dirs: ["src/config", "config"],
    description: "App configuration (env wiring, feature flags).",
  },
  {
    name: "lib",
    dirs: ["src/lib", "lib"],
    description: "Shared application code used by routes and models.",
  },
  {
    name: "database",
    dirs: ["src/db", "db", "src/database", "database", "src/db.ts", "db.ts"],
    description: "Database setup — connections, migrations, seeds.",
  },
];

/** Directory names never descended into while scanning (any depth). */
const PRUNED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".ignex",
  "coverage",
  ".cache",
]);

/**
 * List files under `dir` recursively up to `maxDepth` levels; returns
 * repo-relative-ish paths (relative to `dir`), sorted, capped.
 */
const listFiles = async (
  dir: string,
  maxDepth: number,
): Promise<{ files: string[]; truncated: boolean }> => {
  const out: string[] = [];
  let truncated = false;
  const walk = async (current: string, prefix: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (PRUNED_DIRS.has(entry.name)) continue;
        if (depth >= maxDepth) {
          truncated = true;
          continue;
        }
        await walk(join(current, entry.name), `${prefix}${entry.name}/`, depth + 1);
      } else if (entry.isFile()) {
        out.push(`${prefix}${entry.name}`);
      }
    }
  };
  await walk(dir, "", 0);
  return { files: out, truncated };
};

/** Probe the conventional areas on disk; missing areas are omitted. */
export const scanProjectAreas = async (root: string): Promise<KnowledgeArea[]> => {
  const areas: KnowledgeArea[] = [];
  for (const def of AREA_DEFS) {
    for (const candidate of def.dirs) {
      const abs = resolve(root, candidate);
      // File candidates (e.g. `src/db.ts`): listed as a single-file area.
      if (/\.[cm]?[jt]sx?$/.test(candidate)) {
        try {
          await stat(abs);
        } catch {
          continue;
        }
        areas.push({
          name: def.name,
          dir: candidate,
          description: def.description,
          fileCount: 1,
          files: [basename(candidate)],
        });
        break;
      }
      let entries: Dirent[];
      try {
        entries = await readdir(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      // An empty area is still worth listing only when it really is a folder.
      if (entries.length === 0) continue;
      const { files } = await listFiles(abs, 2);
      areas.push({
        name: def.name,
        dir: candidate,
        description: def.description,
        fileCount: files.length,
        files: files.slice(0, 8),
      });
      break;
    }
  }
  return areas;
};

// ── Documentation inventory ──────────────────────────────────────────────────

/** Extract the doc title from its first `#` heading (falls back to file name). */
const titleFromMarkdown = (source: string, fallback: string): string => {
  for (const line of source.split("\n")) {
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m?.[1]) return m[1].slice(0, 120);
  }
  return fallback;
};

/** Collect markdown docs under one scan root (a `.md` file or a directory). */
const collectDocsUnderRoot = async (root: string, scanPath: string): Promise<KnowledgeDoc[]> => {
  const absScan = resolve(root, scanPath);
  const docs: KnowledgeDoc[] = [];
  // Display paths are relative to the app root when the doc lives inside it
  // (e.g. `docs/architecture.md`); outside roots keep their absolute path.
  const displayPathOf = (absFile: string): string => {
    const rel = relative(root, absFile);
    return (rel === "" || rel.startsWith("..") ? absFile : rel).split("\\").join("/");
  };
  const addDoc = async (absFile: string): Promise<void> => {
    try {
      const source = await readFile(absFile, "utf8");
      const base = basename(displayPathOf(absFile));
      docs.push({
        path: displayPathOf(absFile),
        title: titleFromMarkdown(source, base.replace(/\.md$/i, "")),
      });
    } catch {
      // unreadable doc — skip it, never break the KT page
    }
  };
  const stat = await readdir(absScan, { withFileTypes: true }).then(
    (entries) => ({ ok: true as const, entries }),
    () => ({ ok: false as const }),
  );
  if (!stat.ok) {
    // Not a directory — maybe it IS a markdown file.
    if (/\.md$/i.test(scanPath)) await addDoc(absScan);
    return docs;
  }
  for (const entry of stat.entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || PRUNED_DIRS.has(entry.name)) continue;
    if (entry.isFile() && /\.md$/i.test(entry.name)) {
      await addDoc(join(absScan, entry.name));
    } else if (entry.isDirectory()) {
      const sub = join(absScan, entry.name);
      let subEntries: Dirent[] = [];
      try {
        subEntries = await readdir(sub, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const subEntry of subEntries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (subEntry.isFile() && /\.md$/i.test(subEntry.name)) {
          await addDoc(join(sub, subEntry.name));
        }
      }
    }
  }
  return docs;
};

/**
 * Scan the configured roots for markdown docs and return a deduped inventory
 * (`README.md` first, then alphabetical), capped at 40 entries.
 */
export const scanDocsInventory = async (
  root: string,
  paths?: readonly string[],
): Promise<KnowledgeDoc[]> => {
  const seen = new Set<string>();
  const docs: KnowledgeDoc[] = [];
  for (const scanPath of paths?.length ? paths : defaultDocsPaths) {
    for (const doc of await collectDocsUnderRoot(root, scanPath)) {
      if (seen.has(doc.path)) continue;
      seen.add(doc.path);
      docs.push(doc);
    }
  }
  return docs
    .sort((a, b) => {
      const readme = (p: string) => (basename(p).toLowerCase() === "readme.md" ? 0 : 1);
      return readme(a.path) - readme(b.path) || a.path.localeCompare(b.path);
    })
    .slice(0, 40);
};

/** File name of a path (works with `/` separators only — paths are normalized). */
const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * Build the app knowledge snapshot. Async only because AOT artifacts, the
 * project map and the docs inventory are read from disk; the interpreted
 * route map and all runtime facts are synchronous.
 */
export const buildAppKnowledge = async (
  options: KnowledgeOptions & { router?: IgnexRouter; traces?: readonly RequestTrace[] },
): Promise<AppKnowledge> => {
  const {
    router,
    serviceName,
    version = "0.0.0",
    lifecycle = {},
    plugins = [],
    traces = [],
  } = options;
  const manifestPaths = options.manifestPaths?.length
    ? options.manifestPaths
    : defaultManifestPaths;
  const sdkPaths = options.sdkPaths?.length ? options.sdkPaths : defaultSdkPaths;
  const root = options.projectRoot ?? process.cwd();

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

  const [areas, docs] = await Promise.all([
    scanProjectAreas(root),
    scanDocsInventory(root, options.docsPaths),
  ]);

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
    areas,
    docs,
    dbActions: summarizeDbActivity(traces),
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
      `${knowledge.plugins.length} plugin(s), ${knowledge.lifecycle.length} lifecycle stage(s), ` +
      `${knowledge.docs.length} doc(s), ${knowledge.dbActions.length} distinct DB statement(s) observed. ` +
      `Debug mode: **on**.`,
  );
  lines.push("");

  lines.push("## Where things live");
  lines.push("");
  if (knowledge.areas.length === 0) {
    lines.push(
      "_No conventional app directories found (routes/models/middleware/…). " +
        "This may be a library or a non-standard layout._",
    );
  } else {
    for (const area of knowledge.areas) {
      const isFile = /\.[cm]?[jt]sx?$/.test(area.dir);
      lines.push(`### \`${area.dir}${isFile ? "" : "/"}\` — ${area.name}`);
      lines.push("");
      lines.push(area.description);
      if (area.files.length > 0) {
        lines.push("");
        for (const file of area.files) lines.push(`- \`${file}\``);
      }
      lines.push("");
    }
  }
  lines.push(
    "> Conventions: routes are files under `routes/` — the filename encodes method + path " +
      "(`health.get.ts` → `GET /health`, `users/[id].get.ts` → `GET /users/:id`). " +
      "Cross-cutting behavior lives in plugins (`app.config.ts`) and middleware; " +
      "per-request work is composed in handlers.",
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

  lines.push("## Database activity");
  lines.push("");
  if (knowledge.dbActions.length === 0) {
    lines.push(
      "_No DB queries observed in the retained request window. Wrap calls in " +
        "`ctx.debug.query(sql, params, fn)` or `debugQuery()` — then every statement this app " +
        "runs shows up here with timing and the routes that perform it._",
    );
  } else {
    lines.push(
      "> Observed across the retained request traces — what each route actually does to the " +
        "database. Per-request detail lives in the Queries tab of a trace.",
    );
    lines.push("");
    lines.push("| Action | Table | Calls | Total ms | Statement | Routes |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const a of knowledge.dbActions) {
      const table = a.table ?? "—";
      const routes = a.routes.length > 0 ? a.routes.map((r) => `\`${r}\``).join(", ") : "—";
      lines.push(
        `| ${a.action} | ${table} | ${a.calls} | ${a.totalMs} | \`${a.statement}\` | ${routes} |`,
      );
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

  lines.push("## Documentation");
  lines.push("");
  if (knowledge.docs.length === 0) {
    lines.push(
      "_No markdown docs found (scanned `docs/` and the project root). Set " +
        "`debugbar({ docsPaths: [...] })` if your docs live elsewhere._",
    );
  } else {
    lines.push("| Document | Title |");
    lines.push("| --- | --- |");
    for (const d of knowledge.docs) lines.push(`| \`${d.path}\` | ${d.title} |`);
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
