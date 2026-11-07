/**
 * @fileoverview `ignex add` — the *installable* feature bundles for an app that
 * already exists.
 *
 * `ignex create --features auth` only runs against an empty directory. This
 * module is the shared source of truth behind `ignex add auth[,sessions,…]`:
 * the feature vocabulary (names, aliases, labels), which files each feature
 * contributes — reusing the `ignex create` templates so the two scaffolds can
 * never drift — and the `src/app.config.ts` wiring the plugin/middleware
 * bundles need. `ignex create` imports the vocabulary too, so a new feature
 * is declared once and immediately available to both commands.
 */
import { FEATURE_NAMES, type Feature } from "../types.js";
import { FEATURE_ENV_VARS, type FeatureEnvVar } from "./feature-env.js";
import {
  durableJobsLibTemplate,
  mailerLibTemplate,
  metricsLibTemplate,
  realtimeLibTemplate,
  rpcKitTemplate,
} from "./libs.js";
import { loggerLibTemplate } from "./logger.js";
import {
  middlewareIndexTemplate,
  middlewareLogRequestsTemplate,
  middlewareReadmeTemplate,
  middlewareRequestIdTemplate,
} from "./middleware.js";
import { hasPluginFeatures, pluginsTemplate } from "./project.js";
import {
  authLibTemplate,
  cacheRouteTemplate,
  envRouteTemplate,
  homeTemplate,
  i18nRouteTemplate,
  jobsRouteTemplate,
  layoutTemplate,
  loginRouteTemplate,
  logoutRouteTemplate,
  meRouteTemplate,
  pageRouteTemplate,
  productAddRouteTemplate,
  productByIdRouteTemplate,
  proxyRouteTemplate,
  refreshRouteTemplate,
  registerRouteTemplate,
  requireAuthHookTemplate,
  sessionRouteTemplate,
  sseRouteTemplate,
  testTemplate,
  uploadRouteTemplate,
  vitestConfigTemplate,
  wsExampleTemplate,
} from "./routes.js";
import { readyRouteTemplate } from "./routes-prod.js";

/** Human labels for the feature multi-select shared by `create` and `add`. */
export const FEATURE_LABELS: Record<Feature, string> = {
  cors: "CORS",
  rateLimit: "Rate limiting",
  security: "Security headers",
  compression: "Compression",
  logger: "Logging (access logs + global log)",
  metrics: "Metrics (/metrics + OTLP)",
  middleware: "Global middleware",
  openapi: "OpenAPI docs",
  files: "File uploads",
  ws: "WebSockets",
  sse: "Server-Sent Events",
  realtime: "Realtime hub (nova pub/sub)",
  rpc: "Typed RPC kit (needs realtime)",
  cache: "Browser cache",
  proxy: "HTTP proxy",
  auth: "Auth (register / login / me)",
  refresh: "Refresh tokens + logout",
  sessions: "Sessions",
  templates: "HTML templates",
  env: "Env route",
  ready: "Readiness probe (/ready)",
  jobs: "Jobs route",
  durableJobs: "Durable jobs (SQLite queue)",
  mailer: "Mailer (SMTP / log driver)",
  i18n: "i18n",
  examples: "Example routes",
  tests: "Tests (vitest)",
};

/**
 * Accepted spellings for every feature — the `--features` / `add` vocabulary.
 * Canonical name on the right; aliases preserve muscle memory from other
 * frameworks (`upload`, `websocket`, `rate-limit`).
 */
export const FEATURE_ALIASES: Record<string, Feature> = {
  cors: "cors",
  ratelimit: "rateLimit",
  "rate-limit": "rateLimit",
  rateLimit: "rateLimit",
  security: "security",
  compression: "compression",
  logger: "logger",
  logs: "logger",
  metrics: "metrics",
  middleware: "middleware",
  "global-hooks": "middleware",
  openapi: "openapi",
  files: "files",
  upload: "files",
  ws: "ws",
  websocket: "ws",
  sse: "sse",
  realtime: "realtime",
  nova: "realtime",
  "ws-cluster": "realtime",
  rpc: "rpc",
  "rpc-kit": "rpc",
  cache: "cache",
  proxy: "proxy",
  auth: "auth",
  refresh: "refresh",
  "refresh-tokens": "refresh",
  sessions: "sessions",
  session: "sessions",
  templates: "templates",
  env: "env",
  ready: "ready",
  readiness: "ready",
  jobs: "jobs",
  durablejobs: "durableJobs",
  "durable-jobs": "durableJobs",
  durable_jobs: "durableJobs",
  mailer: "mailer",
  mail: "mailer",
  email: "mailer",
  smtp: "mailer",
  i18n: "i18n",
  examples: "examples",
  tests: "tests",
  test: "tests",
};

/**
 * Parse comma-separated feature tokens into the canonical feature set —
 * `all`/`none`, whitespace- and repetition-tolerant. Unknown names are
 * collected, not thrown, so callers decide between a warning (`ignex create`)
 * and a hard error (`ignex add`).
 *
 * @param input - Raw token(s), e.g. `"auth,refresh"` or `["auth", "sessions"]`.
 * @returns The resolved feature set plus any unrecognized tokens, in order.
 */
export function parseFeatureTokens(input: string | string[] | undefined): {
  features: Set<Feature>;
  unknown: string[];
} {
  const features = new Set<Feature>();
  const unknown: string[] = [];
  if (!input) return { features, unknown };

  for (const raw of Array.isArray(input) ? input : [input]) {
    if (!raw) continue;
    const normalized = String(raw).trim().toLowerCase();
    if (normalized === "all") return { features: new Set(FEATURE_NAMES), unknown };
    if (normalized === "none" || normalized === "") continue;

    for (const part of normalized.split(",")) {
      const token = part.trim();
      if (!token) continue;
      const feature = FEATURE_ALIASES[token];
      if (feature) features.add(feature);
      else if (!unknown.includes(token)) unknown.push(token);
    }
  }

  return { features, unknown };
}

/**
 * Close the feature set over its dependencies: `refresh` needs `auth` (the
 * refresh manager is emitted into `src/lib/auth.ts`), `rpc` needs `realtime`
 * (the kit dispatches over the nova hub) — the same rule `ignex create`
 * applies.
 *
 * @param features - The requested feature set (not mutated).
 * @returns A new set with every implied feature included.
 */
export function withFeatureDependencies(features: ReadonlySet<Feature>): Set<Feature> {
  const resolved = new Set(features);
  if (resolved.has("refresh")) resolved.add("auth");
  if (resolved.has("rpc")) resolved.add("realtime");
  return resolved;
}

/** One file an `ignex add` run writes, with a project-root-relative path. */
export interface FeatureFile {
  /** Path relative to the project root (e.g. `src/lib/auth.ts`). */
  readonly path: string;
  /** Lazy content factory — nothing is rendered until the file is written. */
  readonly content: () => string;
}

/** A {@link FeatureFile} tagged with the feature that contributed it. */
export interface PlannedFeatureFile extends FeatureFile {
  readonly feature: Feature;
}

/** Context handed to the per-feature file builders. */
export interface FeaturePlanContext {
  /** Package name — the `tests` bundle asserts it from `GET /`. */
  readonly appName: string;
  /** The full resolved selection; a feature may shape another's files. */
  readonly features: ReadonlySet<Feature>;
}

/**
 * Files each feature adds to an existing app. Exhaustive by construction
 * (`Record<Feature, …>`): adding to `FEATURE_NAMES` fails to compile until
 * it is declared here. Plugin-only features wire through `src/plugins/
 * index.ts`, produced once by {@link planInstall}.
 */
const FEATURE_FILES: Record<Feature, (ctx: FeaturePlanContext) => readonly FeatureFile[]> = {
  // Plugin-only features: their wiring lives in `src/plugins/index.ts`.
  cors: () => [],
  rateLimit: () => [],
  security: () => [],
  compression: () => [],
  // `openapi()` ships in the baseline app config, so there is no plugin to add.
  openapi: () => [],

  logger: () => [{ path: "src/lib/logger.ts", content: () => loggerLibTemplate() }],
  metrics: () => [{ path: "src/lib/metrics.ts", content: () => metricsLibTemplate() }],
  middleware: () => [
    { path: "src/middleware/README.md", content: () => middlewareReadmeTemplate() },
    { path: "src/middleware/index.ts", content: () => middlewareIndexTemplate() },
    { path: "src/middleware/request-id.ts", content: () => middlewareRequestIdTemplate() },
    { path: "src/middleware/log-requests.ts", content: () => middlewareLogRequestsTemplate() },
  ],
  auth: (ctx) => {
    const refresh = ctx.features.has("refresh");
    return [
      { path: "src/lib/auth.ts", content: () => authLibTemplate({ refresh }) },
      { path: "src/hooks/require-auth.ts", content: () => requireAuthHookTemplate() },
      {
        path: "src/routes/auth/register.post.ts",
        content: () => registerRouteTemplate({ refresh }),
      },
      { path: "src/routes/auth/login.post.ts", content: () => loginRouteTemplate({ refresh }) },
      { path: "src/routes/auth/me.get.ts", content: () => meRouteTemplate() },
    ];
  },
  refresh: () => [
    { path: "src/routes/auth/refresh.post.ts", content: () => refreshRouteTemplate() },
    { path: "src/routes/auth/logout.post.ts", content: () => logoutRouteTemplate() },
  ],
  sessions: () => [{ path: "src/routes/session.get.ts", content: () => sessionRouteTemplate() }],
  realtime: () => [{ path: "src/lib/realtime.ts", content: () => realtimeLibTemplate() }],
  rpc: () => [{ path: "src/rpc/kit.ts", content: () => rpcKitTemplate() }],
  templates: () => [
    { path: "src/views/layout.html", content: () => layoutTemplate() },
    { path: "src/views/home.html", content: () => homeTemplate() },
    { path: "src/routes/page.get.ts", content: () => pageRouteTemplate() },
  ],
  env: () => [{ path: "src/routes/env.get.ts", content: () => envRouteTemplate() }],
  ready: () => [{ path: "src/routes/ready.get.ts", content: () => readyRouteTemplate() }],
  jobs: () => [{ path: "src/routes/jobs.get.ts", content: () => jobsRouteTemplate() }],
  durableJobs: () => [{ path: "src/lib/jobs.ts", content: () => durableJobsLibTemplate() }],
  mailer: () => [{ path: "src/lib/mailer.ts", content: () => mailerLibTemplate() }],
  i18n: () => [{ path: "src/routes/i18n.get.ts", content: () => i18nRouteTemplate() }],
  examples: () => [
    { path: "src/routes/products/[id].get.ts", content: () => productByIdRouteTemplate() },
    { path: "src/routes/products/add.post.ts", content: () => productAddRouteTemplate() },
  ],
  files: () => [{ path: "src/routes/upload.post.ts", content: () => uploadRouteTemplate() }],
  ws: () => [{ path: "src/ws.example.ts", content: () => wsExampleTemplate() }],
  sse: () => [{ path: "src/routes/events.get.ts", content: () => sseRouteTemplate() }],
  cache: () => [{ path: "src/routes/cached.get.ts", content: () => cacheRouteTemplate() }],
  proxy: () => [{ path: "src/routes/proxy.get.ts", content: () => proxyRouteTemplate() }],
  tests: (ctx) => [
    { path: "vitest.config.ts", content: () => vitestConfigTemplate() },
    { path: "test/app.test.ts", content: () => testTemplate(ctx.appName) },
  ],
};

/**
 * Follow-ups that are not file writes: an extra dependency or how to use
 * what was just installed (wiring notes are emitted by the command itself).
 */
const FEATURE_NOTES: Partial<Record<Feature, readonly string[]>> = {
  auth: [
    'Guard any route with the hook: export const config = { hooks: ["require-auth"] };',
    "Production: set JWT_PRIVATE_KEY / JWT_PUBLIC_KEY (a dev keypair is bootstrapped into .env on first run).",
  ],
  examples: ["Add the schema dep: bun add typebox"],
  tests: ["Add the runner: bun add -D vitest @vitest/ui"],
  openapi: [
    "openapi() is part of the baseline src/app.config.ts — nothing to wire.",
    "For the generated client: bun add -D @hey-api/openapi-ts",
  ],
  metrics: [
    "Scrape GET /metrics from Prometheus — protect it with METRICS_TOKEN (generated by `ignex ship`).",
    "Optional OTLP push: set OTLP_ENDPOINT (requires the @opentelemetry SDK packages).",
  ],
  realtime: [
    "Install the peer: bun add @ignex/nova",
    "The hub listens on NOVA_PORT (default 3001) — expose it via your proxy, sticky sessions when scaled.",
  ],
  rpc: [
    "Define methods in src/rpc/kit.ts, then `await rpc.registerDispatcher()` after the hub boots.",
    "The SDK-facing manifest lands in .ignex/rpc-manifest.json.",
  ],
  ready: [
    "Add one check per real dependency to the checks array — 503 pulls the replica from the LB.",
  ],
  durableJobs: [
    "Process the queue with: ignex queue:work (run 2+ workers for redundancy).",
    "Enqueue from any route: await jobs.enqueue({ name, payload }).",
  ],
  mailer: ["Uses the log driver until SMTP_HOST is set — sends never throw on the request path."],
};

/** The `src/app.config.ts` edits an install plan needs. */
export interface InstallWiring {
  /** Spread `...appPlugins` from `src/plugins/index.ts` into `plugins`. */
  readonly plugins: boolean;
  /** Spread `...middleware` and register the example `beforeHandle` hooks. */
  readonly middleware: boolean;
}

/** Everything `ignex add` needs to render, write, and explain an install. */
export interface InstallPlan {
  /** Resolved features (dependencies closed), in canonical order. */
  readonly features: readonly Feature[];
  /** Files to create, tagged with their owning feature. */
  readonly files: readonly PlannedFeatureFile[];
  /** `src/plugins/index.ts` content when plugin features were selected. */
  readonly pluginsFile?: FeatureFile;
  /** Wiring to apply to `src/app.config.ts` (see {@link InstallWiring}). */
  readonly wire: InstallWiring;
  /** False when `src/plugins/index.ts` is needed but wiring was not requested. */
  readonly notes: readonly string[];
  /**
   * Env vars to wire into `src/config/env.ts` + `.env.example`
   * (`utils/env-vars.ts`). Order: feature-canonical, deduped by key.
   */
  readonly envVars: readonly FeatureEnvVar[];
}

/**
 * Plan an `ignex add` run: the files to write, the plugins module to emit, and
 * the app-config wiring to apply.
 *
 * Pure and side-effect free (file contents stay lazy), so `--dry-run` and the
 * tests can render the exact plan without touching the filesystem.
 *
 * @param requested - Features the user asked for (aliases already normalized).
 * @param appName - Package name, used by the `tests` bundle.
 * @returns The ordered install plan.
 */
export function planInstall(requested: ReadonlySet<Feature>, appName = "ignex-app"): InstallPlan {
  const features = withFeatureDependencies(requested);
  const ctx: FeaturePlanContext = { appName, features };

  // Canonical order + first-wins dedupe: two features may legitimately target
  // the same path (e.g. `auth` and `refresh` both touch src/lib/auth.ts).
  const files = new Map<string, PlannedFeatureFile>();
  const selected: Feature[] = [];
  for (const feature of FEATURE_NAMES) {
    if (!features.has(feature)) continue;
    selected.push(feature);
    for (const file of FEATURE_FILES[feature](ctx)) {
      if (!files.has(file.path)) files.set(file.path, { ...file, feature });
    }
  }

  const wirePlugins = hasPluginFeatures(features);
  const notes = [...new Set(selected.flatMap((feature) => FEATURE_NOTES[feature] ?? []))];
  const seenEnvKeys = new Set<string>();
  const envVars = selected.flatMap((feature) =>
    (FEATURE_ENV_VARS[feature] ?? []).filter((envVar) => {
      if (seenEnvKeys.has(envVar.key)) return false;
      seenEnvKeys.add(envVar.key);
      return true;
    }),
  );

  return {
    features: selected,
    files: [...files.values()],
    ...(wirePlugins
      ? {
          pluginsFile: {
            path: "src/plugins/index.ts",
            content: () => pluginsTemplate({ features }),
          },
        }
      : {}),
    wire: { plugins: wirePlugins, middleware: features.has("middleware") },
    notes,
    envVars,
  };
}
