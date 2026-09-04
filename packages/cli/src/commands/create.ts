import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { type ArgsDef, defineCommand, parseArgs } from "citty";
import { envConfigTemplate, envExampleTemplate } from "../templates/env.js";
import { loggerLibTemplate } from "../templates/logger.js";
import {
  middlewareIndexTemplate,
  middlewareLogRequestsTemplate,
  middlewareReadmeTemplate,
  middlewareRequestIdTemplate,
} from "../templates/middleware.js";
import type { ProjectTemplateOptions } from "../templates/project.js";
import {
  biomeTemplate,
  gitignoreTemplate,
  hasPluginFeatures,
  ignexConfigTemplate,
  packageJsonTemplate,
  pluginsTemplate,
  readmeTemplate,
  tsconfigTemplate,
} from "../templates/project.js";
import {
  appConfigTemplate,
  authLibTemplate,
  cacheRouteTemplate,
  envRouteTemplate,
  healthRouteTemplate,
  homeTemplate,
  i18nRouteTemplate,
  indexRouteTemplate,
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
} from "../templates/routes.js";
import { FEATURE_NAMES, type Feature } from "../types.js";
import { exists, isDirEmpty, writeFileEnsuringDir } from "../utils/fs.js";
import { error, step, success, warn } from "../utils/logger.js";
import {
  PromptCancelError,
  promptConfirm,
  promptMultiSelect,
  promptSelect,
  promptText,
} from "../utils/prompt.js";
import { normalizeRuntime } from "../utils/runtime.js";
import { metaFor } from "./registry.js";

/** Typed CLI surface shared by parsing and usage rendering. */
const argsDef = {
  name: {
    type: "positional",
    required: false,
    description: "Project name (e.g. my-app)",
  },
  root: { type: "string", valueHint: "dir", description: "Parent directory for the new app" },
  runtime: {
    type: "string",
    valueHint: "bun",
    description: "Runtime (bun only — the generated server requires Bun)",
  },
  pm: { type: "string", valueHint: "bun|npm|pnpm|yarn", description: "Package manager" },
  features: {
    type: "string",
    valueHint: "auth,openapi,tests,...",
    description: "Comma-separated features (or `all` / `none`)",
  },
  protocol: {
    type: "string",
    valueHint: "https2|https|http",
    description: "Transport: https2 (TLS + HTTP/2), https (TLS, default) or http (plain)",
  },
  install: {
    type: "boolean",
    default: true,
    description: "Install dependencies after scaffolding (--no-install to skip)",
  },
  git: {
    type: "boolean",
    default: true,
    description: "git init the new app (--no-git to skip)",
  },
  yes: { type: "boolean", description: "Skip the feature wizard (use defaults)" },
  force: { type: "boolean", description: "Overwrite an existing non-empty directory" },
} satisfies ArgsDef;

export const createCmd = defineCommand({
  meta: metaFor("create"),
  args: argsDef,
  async run(ctx) {
    await runCreate(ctx.rawArgs);
  },
});

export default createCmd;

/**
 * Default `--yes` / interactive features. Includes the baseline plugin set
 * (cors/compression/security/logger) so a default scaffold is feature-driven
 * (`src/plugins/index.ts`) yet behaves like the classic kitchen-sink app
 * config; users can drop/add plugins via `--features`.
 */
const DEFAULT_FEATURES = "openapi,middleware,examples,tests,cors,compression,security,logger";

interface CreateDefaults {
  name?: string;
  runtime?: string;
  pm?: string;
  features?: string | string[];
  protocol?: string;
  install?: boolean;
  git?: boolean;
}

/** Human labels for the feature multi-select in the create wizard. */
const FEATURE_LABELS: Record<Feature, string> = {
  cors: "CORS",
  rateLimit: "Rate limiting",
  security: "Security headers",
  compression: "Compression",
  logger: "Logging (access logs + global log)",
  middleware: "Global middleware",
  openapi: "OpenAPI docs",
  files: "File uploads",
  ws: "WebSockets",
  sse: "Server-Sent Events",
  cache: "Browser cache",
  proxy: "HTTP proxy",
  auth: "Auth (register / login / me)",
  refresh: "Refresh tokens + logout",
  sessions: "Sessions",
  templates: "HTML templates",
  env: "Env route",
  jobs: "Jobs route",
  i18n: "i18n",
  examples: "Example routes",
  tests: "Tests (vitest)",
};

/** Ask the user for any option not already provided (TTY only). */
async function resolveInteractive(options: CreateDefaults): Promise<Required<CreateDefaults>> {
  const name =
    options.name ?? (await promptText({ message: "Project name", initial: "ignex-app" }));
  const runtime =
    options.runtime ??
    (await promptSelect({
      message: "Runtime",
      options: [{ value: "bun", label: "Bun", hint: "the only runtime ignex targets" }],
      initial: "bun",
    }));
  const pm =
    options.pm ??
    (await promptSelect({
      message: "Package manager",
      options: [{ value: "bun" }, { value: "npm" }, { value: "pnpm" }, { value: "yarn" }],
      initial: "bun",
    }));
  const defaultFeatures = DEFAULT_FEATURES.split(",");

  const protocol =
    options.protocol ??
    (await promptSelect({
      message: "Protocol",
      options: [
        {
          value: "https2",
          label: "HTTPS + HTTP/2",
          hint: "TLS + HTTP/2 (ALPN) — Bun 1.4.1+",
        },
        {
          value: "https",
          label: "HTTPS",
          hint: "TLS — HTTP/1.1 (add h2: true later for HTTP/2)",
        },
        { value: "http", label: "HTTP", hint: "plain HTTP/1 — no TLS" },
      ],
      initial: "https",
    }));

  // 1. Get the raw input (could be string, string[], or undefined)
  const rawFeatures =
    options.features ??
    (await promptMultiSelect({
      message: "Features to scaffold",
      options: FEATURE_NAMES.map((feature) => ({
        value: feature,
        label: FEATURE_LABELS[feature],
      })),
      initial: defaultFeatures,
    }));

  // 2. Normalize to a single string
  const features = Array.isArray(rawFeatures) ? rawFeatures.join(",") : rawFeatures;

  const install =
    options.install ?? (await promptConfirm({ message: "Install dependencies?", initial: true }));
  const git = options.git ?? (await promptConfirm({ message: "Initialize git?", initial: true }));
  return { name, runtime, pm, features, protocol, install, git };
}

/** One planned scaffold file: target-relative `path` + a content factory. */
interface PlannedFile {
  readonly path: string;
  /**
   * Gate: the file is written only when this holds (feature name, any-of
   * feature list, or predicate over the enabled feature set). Always written
   * when omitted.
   */
  readonly when?: Feature | Feature[] | ((features: Set<Feature>) => boolean);
  readonly content: () => string;
}

/** The full scaffold file plan — base files plus feature-conditional ones. */
const plannedFiles = (opts: ProjectTemplateOptions): readonly PlannedFile[] => {
  const features = opts.features;

  return [
    // Base files (always written).
    { path: "package.json", content: () => packageJsonTemplate(opts) },
    { path: "tsconfig.json", content: () => tsconfigTemplate() },
    { path: "ignex.config.mjs", content: () => ignexConfigTemplate() },
    { path: "biome.json", content: () => biomeTemplate() },
    { path: ".gitignore", content: () => gitignoreTemplate() },
    { path: "README.md", content: () => readmeTemplate(opts) },
    // Validated env config + .env.example (base — src/app.config.ts imports it).
    { path: "src/config/env.ts", content: () => envConfigTemplate() },
    { path: ".env.example", content: () => envExampleTemplate() },
    { path: "src/routes/index.get.ts", content: () => indexRouteTemplate(opts.name) },
    { path: "src/routes/health.get.ts", content: () => healthRouteTemplate() },
    { path: "src/hooks/README.md", content: () => `# Hooks\n\nPlace shared hooks here.\n` },

    // Feature-conditional routes/plugins/hooks.
    {
      path: "src/routes/products/[id].get.ts",
      when: "examples",
      content: () => productByIdRouteTemplate(),
    },
    {
      path: "src/routes/products/add.post.ts",
      when: "examples",
      content: () => productAddRouteTemplate(),
    },
    { path: "src/routes/upload.post.ts", when: "files", content: () => uploadRouteTemplate() },
    { path: "src/routes/events.get.ts", when: "sse", content: () => sseRouteTemplate() },
    { path: "src/routes/cached.get.ts", when: "cache", content: () => cacheRouteTemplate() },
    { path: "src/routes/proxy.get.ts", when: "proxy", content: () => proxyRouteTemplate() },
    {
      path: "src/plugins/index.ts",
      when: (f) => hasPluginFeatures(f),
      content: () => pluginsTemplate(opts),
    },
    {
      // Global app logger (`log` importable from any route/hook/service) —
      // ships with the `logger` access-log feature so app logs and access
      // logs share the same level/redaction config.
      path: "src/lib/logger.ts",
      when: "logger",
      content: () => loggerLibTemplate(),
    },
    { path: "src/ws.example.ts", when: "ws", content: () => wsExampleTemplate() },
    {
      path: "src/middleware/README.md",
      when: "middleware",
      content: () => middlewareReadmeTemplate(),
    },
    {
      path: "src/middleware/index.ts",
      when: "middleware",
      content: () => middlewareIndexTemplate(),
    },
    {
      path: "src/middleware/request-id.ts",
      when: "middleware",
      content: () => middlewareRequestIdTemplate(),
    },
    {
      path: "src/middleware/log-requests.ts",
      when: "middleware",
      content: () => middlewareLogRequestsTemplate(),
    },
    {
      path: "src/lib/auth.ts",
      when: "auth",
      content: () => authLibTemplate({ refresh: features.has("refresh") }),
    },
    {
      path: "src/hooks/require-auth.ts",
      when: "auth",
      content: () => requireAuthHookTemplate(),
    },
    {
      path: "src/routes/auth/register.post.ts",
      when: "auth",
      content: () => registerRouteTemplate({ refresh: features.has("refresh") }),
    },
    {
      path: "src/routes/auth/login.post.ts",
      when: "auth",
      content: () => loginRouteTemplate({ refresh: features.has("refresh") }),
    },
    { path: "src/routes/auth/me.get.ts", when: "auth", content: () => meRouteTemplate() },
    {
      path: "src/routes/auth/refresh.post.ts",
      when: "refresh",
      content: () => refreshRouteTemplate(),
    },
    {
      path: "src/routes/auth/logout.post.ts",
      when: "refresh",
      content: () => logoutRouteTemplate(),
    },
    {
      path: "src/routes/session.get.ts",
      when: "sessions",
      content: () => sessionRouteTemplate(),
    },
    {
      // Every scaffold gets the baseline app config (debugbar + session +
      // openapi plugins, validated env wiring, HTTPS server); feature
      // selections additionally populate the middleware/plugin arrays.
      path: "src/app.config.ts",
      content: () =>
        appConfigTemplate({
          middleware: features.has("middleware"),
          plugins: hasPluginFeatures(features),
          https: opts.https,
          h2: opts.h2,
        }),
    },
    { path: "src/views/layout.html", when: "templates", content: () => layoutTemplate() },
    { path: "src/views/home.html", when: "templates", content: () => homeTemplate() },
    { path: "src/routes/page.get.ts", when: "templates", content: () => pageRouteTemplate() },
    { path: "src/routes/i18n.get.ts", when: "i18n", content: () => i18nRouteTemplate() },
    { path: "src/routes/env.get.ts", when: "env", content: () => envRouteTemplate() },
    { path: "src/routes/jobs.get.ts", when: "jobs", content: () => jobsRouteTemplate() },
    { path: "vitest.config.ts", when: "tests", content: () => vitestConfigTemplate() },
    {
      path: "test/app.test.ts",
      when: "tests",
      content: () => testTemplate(opts.name, opts.runtime),
    },
  ];
};

/** Write every scaffolded file (feature-conditional routes/plugins/hooks). */
async function scaffoldFiles(target: string, opts: ProjectTemplateOptions): Promise<void> {
  for (const { path, when, content } of plannedFiles(opts)) {
    let enabled = true;
    if (when !== undefined) {
      if (typeof when === "function") {
        enabled = when(opts.features);
      } else if (Array.isArray(when)) {
        enabled = when.some((name) => opts.features.has(name));
      } else {
        enabled = opts.features.has(when);
      }
    }
    if (!enabled) continue;
    await writeFileEnsuringDir(join(target, path), content());
  }
}

/** Run `git init` in the scaffolded project (best-effort). */
function initGit(target: string): void {
  const result = spawnSync("git", ["init"], { cwd: target, stdio: "ignore" });
  if (result.error) {
    warn(`Could not initialize git: ${result.error.message}`);
  }
}

/** Run the package manager's install in the scaffolded project (best-effort). */
function installDeps(pm: string, target: string): void {
  const result = spawnSync(pm, ["install"], {
    cwd: target,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) {
    warn(`Could not run ${pm} install: ${result.error.message}`);
  }
}

/** Print the post-scaffold success + next-steps block. */
function printNextSteps(rel: string, install: boolean, pm: string, name: string): void {
  console.log();
  success(`Created ${name}`);
  console.log();
  console.log("Next steps:");
  if (rel !== ".") {
    console.log(`  cd ${rel}`);
  }
  if (!install) {
    console.log(`  ${pm} install`);
  }
  console.log(`  ${pm} run dev`);
  console.log();
}

/** Normalized inputs after merging flags + interactive answers. */
interface CreateInputs {
  name: string;
  runtimeInput?: string;
  pmInput?: string;
  featuresInput?: string | string[];
  protocolInput?: string;
  install: boolean;
  git: boolean;
}

/** Merge CLI flags with wizard answers (TTY) into normalized inputs. */
async function resolveCreateInputs(
  parsed: ReturnType<typeof parseArgs<typeof argsDef>>,
  interactive: boolean,
): Promise<CreateInputs | undefined> {
  let name = parsed.name;
  let runtimeInput = parsed.runtime;
  let pmInput = parsed.pm;
  let protocolInput = parsed.protocol;

  // Explicitly type and cast to handle runtime arrays from duplicate flags (e.g. --features a --features b)
  let featuresInput: string | string[] | undefined = parsed.features as
    | string
    | string[]
    | undefined;

  let install = parsed.install;
  let git = parsed.git;
  // citty native boolean negation: `--no-install` → `parsed.install === false`,
  // `--no-git` → `parsed.git === false`. No literal `no-` keys to inspect.

  if (interactive) {
    try {
      const resolved = await resolveInteractive({
        name,
        runtime: runtimeInput,
        pm: pmInput,
        features: featuresInput,
        protocol: protocolInput,
        install,
        git,
      });
      name = resolved.name;
      runtimeInput = resolved.runtime;
      pmInput = resolved.pm;
      featuresInput = resolved.features; // Now perfectly type-safe
      protocolInput = resolved.protocol;
      install = resolved.install;
      git = resolved.git;
    } catch (err) {
      if (err instanceof PromptCancelError) return undefined;
      throw err;
    }
  }

  return {
    name: name ?? "ignex-app",
    runtimeInput,
    pmInput,
    featuresInput,
    protocolInput,
    install: install ?? false,
    git: git ?? false,
  };
}

export async function runCreate(args: string[]): Promise<void> {
  const parsed = parseArgs<typeof argsDef>(args, argsDef);

  const interactive = Boolean(process.stdin.isTTY && !parsed.yes);
  const inputs = await resolveCreateInputs(parsed, interactive);
  if (!inputs) return; // wizard cancelled
  const { name, runtimeInput, pmInput, featuresInput, protocolInput, install, git } = inputs;

  const runtime = normalizeRuntime(runtimeInput);
  const pm = normalizePm(pmInput, runtime);
  const protocol = normalizeProtocol(protocolInput);

  const features = parseFeatures(featuresInput ?? (parsed.yes ? DEFAULT_FEATURES : "none"));

  if (features.has("refresh") && !features.has("auth")) {
    features.add("auth");
    warn("'refresh' requires 'auth' — enabling 'auth' too.");
  }

  // `--root <dir>` targets an explicit parent directory; otherwise the app is
  // scaffolded into a folder named `name` inside the current directory.
  const baseDir = resolve(parsed.root ? String(parsed.root) : process.cwd());
  const target = resolve(baseDir, name);

  // Reject path traversal / absolute project names so `--name ../x` (or an
  // absolute path) cannot silently write outside the current directory.
  if (name.includes("..") || name.startsWith("/") || /^[A-Za-z]:\\/.test(name)) {
    error(`Invalid project name: ${name}. Use a simple name inside the current directory.`);
    process.exitCode = 1;
    return;
  }

  if (await exists(target)) {
    if (!(await isDirEmpty(target)) && !parsed.force) {
      error(`${name} already exists and is not empty. Use --force to overwrite.`);
      process.exitCode = 1;
      return;
    }
  }

  step(`Scaffolding ${name}`);

  const opts = {
    name,
    runtime,
    pm,
    features,
    https: protocol !== "http",
    h2: protocol === "https2",
  };

  await scaffoldFiles(target, opts);
  if (git) initGit(target);
  if (install) installDeps(pm, target);

  // Prefer a cwd-relative path for the next-steps hint; fall back to the
  // absolute path when the app lives outside the current directory.
  const rel = relative(process.cwd(), target) || ".";
  printNextSteps(rel.startsWith("..") ? target : rel, install, pm, name);
}

/**
 * Normalize the `--protocol` value.
 *
 * `https2` (also `http2`/`h2`) = HTTPS + HTTP/2 over TLS; `https` = HTTPS with
 * HTTP/1.1 (the default); `http` = plain HTTP. Anything else falls back to
 * `https`.
 */
type ProtocolChoice = "https2" | "https" | "http";

function normalizeProtocol(input: string | undefined): ProtocolChoice {
  switch (input?.trim().toLowerCase()) {
    case "https2":
    case "http2":
    case "h2":
      return "https2";
    case "http":
      return "http";
    default:
      return "https";
  }
}

function normalizePm(input: string | undefined, runtime: "bun" | "node"): string {
  const lower = input?.toLowerCase();

  if (lower === "bun" || lower === "npm" || lower === "pnpm" || lower === "yarn") {
    return lower;
  }

  return runtime === "bun" ? "bun" : "npm";
}

const FEATURE_ALIASES: Record<string, Feature> = {
  cors: "cors",
  ratelimit: "rateLimit",
  "rate-limit": "rateLimit",
  rateLimit: "rateLimit",
  security: "security",
  compression: "compression",
  logger: "logger",
  logs: "logger",
  middleware: "middleware",
  "global-hooks": "middleware",
  openapi: "openapi",
  files: "files",
  upload: "files",
  ws: "ws",
  websocket: "ws",
  sse: "sse",
  cache: "cache",
  proxy: "proxy",
  auth: "auth",
  refresh: "refresh",
  "refresh-tokens": "refresh",
  sessions: "sessions",
  session: "sessions",
  templates: "templates",
  env: "env",
  jobs: "jobs",
  i18n: "i18n",
  examples: "examples",
  tests: "tests",
  test: "tests",
};

export function parseFeatures(input: string | string[] | undefined): Set<Feature> {
  if (!input) return new Set();

  // Normalize input to an array of strings
  const inputs = Array.isArray(input) ? input : [input];
  const out = new Set<Feature>();

  for (const raw of inputs) {
    if (!raw) continue;
    const normalized = String(raw).trim().toLowerCase();

    if (normalized === "all") {
      return new Set(FEATURE_NAMES);
    }

    if (normalized === "none" || normalized === "") {
      continue; // Skip "none" if mixed with other features
    }

    for (const rawToken of normalized.split(",")) {
      const token = rawToken.trim();
      if (!token) continue;

      const feature = FEATURE_ALIASES[token];

      if (feature) {
        out.add(feature);
      } else {
        warn(`Unknown feature: ${token}`);
      }
    }
  }

  return out;
}
