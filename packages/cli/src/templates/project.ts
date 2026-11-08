import type { Feature } from "../types.js";
import { cliVersion } from "../version.js";

export interface ProjectTemplateOptions {
  name: string;
  /** Always "bun" — the generated server requires Bun (Bun.serve, no Node shim). */
  runtime: "bun";
  pm: string;
  features: Set<Feature>;
  /** Serve HTTPS over TLS (default) or plain HTTP/1 — wired into `server.https`. */
  https: boolean;
  /** Serve HTTP/2 over TLS too (ALPN) — only meaningful when `https`; Bun ≥1.4.1. */
  h2: boolean;
}

/** Features that contribute a plugin factory to `src/plugins/index.ts`. */
export const PLUGIN_FEATURES: readonly Feature[] = [
  "cors",
  "rateLimit",
  "security",
  "compression",
  "logger",
  "metrics",
  "auth",
  "mailer",
  "realtime",
  "rpc",
];

/**
 * Plugin wiring that departs from the bare `${feature}()` call: the extra
 * import lines (beyond `@ignex/core`) and the exact call expression.
 * Features absent here keep the default factory call.
 */
const PLUGIN_EMISSIONS: Partial<Record<Feature, { imports: readonly string[]; call: string }>> = {
  metrics: {
    imports: [
      '{ metrics, metricsLifecycle } from "../lib/metrics.js"',
      '{ env } from "../config/env.js"',
    ],
    call: 'metricsPlugin({ metrics, path: "/metrics", token: env.METRICS_TOKEN }), metricsLifecycle',
  },
  auth: {
    imports: ['{ authLifecycle } from "../lib/auth.js"'],
    call: "authLifecycle",
  },
  mailer: {
    imports: ['{ mailerLifecycle } from "../lib/mailer.js"'],
    call: "mailerLifecycle",
  },
  realtime: {
    imports: ['{ realtime } from "../lib/realtime.js"'],
    call: "realtime",
  },
  rpc: {
    imports: ['{ rpcLifecycle } from "../rpc/kit.js"'],
    call: "rpcLifecycle",
  },
};

/** True when any selected feature contributes a plugin to `src/plugins/index.ts`. */
export function hasPluginFeatures(features: ReadonlySet<Feature>): boolean {
  return PLUGIN_FEATURES.some((feature) => features.has(feature));
}

export function packageJsonTemplate(opts: ProjectTemplateOptions): string {
  const safeName =
    opts.name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "ignex-app";

  const frameworkRange = `^${cliVersion()}`;
  const dependencies: Record<string, string> = {
    "@ignex/core": frameworkRange,
  };

  if (
    opts.features.has("examples") ||
    opts.features.has("auth") ||
    opts.features.has("refresh") ||
    opts.features.has("rpc")
  ) {
    dependencies.typebox = "^1.3.15";
  }

  const devDependencies: Record<string, string> = {
    "@ignex/cli": frameworkRange,
    "@biomejs/biome": "^2.5.5",
    oxlint: "^1.74.0",
    typescript: "^7.0.2",
  };

  devDependencies["@types/bun"] = "^1.3.14";

  if (opts.features.has("openapi")) {
    devDependencies["@hey-api/openapi-ts"] = "^0.99.0";
  }

  if (opts.features.has("tests")) {
    devDependencies.vitest = "^4.1.10";
    devDependencies["@vitest/ui"] = "^4.1.10";
  }

  const scripts: Record<string, string> = {
    dev: "ignex dev",
    build: "ignex build",
    start: "bun .ignex/server.js",
    route: "ignex route",
    // The cross-platform provisioner — see scripts/setup.ts (entry points:
    // ./setup.sh / setup.bat install Bun first when it is missing).
    setup: "bun scripts/setup.ts",
    lint: "biome check .",
    format: "biome format --write .",
    typecheck: "tsc --noEmit",
  };

  if (opts.features.has("tests")) {
    scripts.test = "vitest run";
  }

  const pkg = {
    name: safeName,
    private: true,
    type: "module",
    scripts,
    dependencies,
    devDependencies,
  };

  return `${JSON.stringify(pkg, null, 2)}\n`;
}

export function tsconfigTemplate(): string {
  const tsconfig = {
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      lib: ["ESNext"],
      strict: true,
      noUncheckedIndexedAccess: true,
      verbatimModuleSyntax: true,
      skipLibCheck: true,
      noEmit: true,
      types: ["bun"],
    },
    include: ["src", "test", "ignex.config.ts", "ignex.config.mjs"],
  };

  return `${JSON.stringify(tsconfig, null, 2)}\n`;
}

export function ignexConfigTemplate(): string {
  return `/** @type {import("@ignex/cli/config").IgnexProjectConfig} */
// Set only project-specific overrides; optimized defaults live in the framework.
export default {};
`;
}
export function biomeTemplate(): string {
  const biome = {
    $schema: "https://biomejs.dev/schemas/2.5.10/schema.json",
    assist: {
      actions: {
        source: {
          organizeImports: "on",
        },
      },
    },
    linter: {
      enabled: true,
    },
    formatter: {
      enabled: true,
      indentStyle: "space",
    },
  };

  return `${JSON.stringify(biome, null, 2)}\n`;
}

export function gitignoreTemplate(): string {
  return `node_modules
.ignex
dist
coverage
*.log
.env
.DS_Store
`;
}

export function readmeTemplate(opts: ProjectTemplateOptions): string {
  const features = [...opts.features].join(", ") || "none";
  const auth = opts.features.has("auth");
  const refresh = opts.features.has("refresh");
  const tokens = refresh ? " + refresh" : "";
  const authSection = auth
    ? `
## Auth

\`src/lib/auth.ts\` wires an Ed25519 \`authModule()\` (short-lived access tokens;
\`JWT_PRIVATE_KEY\` / \`JWT_PUBLIC_KEY\` are bootstrapped into \`.env\` in development),
a SQLite-backed user store, and the \`require-auth\` hook used via \`config.hooks\`.
Production requires pre-provisioned JWT keys.

- \`POST /auth/register\` — create a user → access${tokens} token
- \`POST /auth/login\` — verify credentials → access${tokens} token
- \`GET /auth/me\` — current user claims (requires \`Bearer\` access token)
${
  refresh
    ? `- \`POST /auth/refresh\` — exchange a refresh token for a new access token
- \`POST /auth/logout\` — revoke a refresh token
`
    : ""
}
`
    : "";

  return `# ${opts.name}

Generated by @ignex/cli.

## Features

${features}

## Scripts

- \`./setup.sh\` (macOS/Linux) or \`setup.bat\` (Windows) - install Bun if missing, then provision this machine: tooling, .env, dependencies, build and a smoke test of the compiled server. Flags: \`--check\` (detection report), \`--docker\`, \`--caddy\`, \`--systemd\`
- \`${opts.pm} run setup\` - same provisioner without the Bun bootstrap
- \`${opts.pm} run dev\` - build, watch, and restart the generated server
- \`${opts.pm} run build\` - compile the app
- \`${opts.pm} run start\` - run the compiled server
- \`${opts.pm} run route -- products/[id].get\` - scaffold a route

## Hello World

Routes are files under \`src/routes\`; the path and method come from the filename.
The handler can be exported as a default **or** a named binding:

\`\`\`ts
// src/routes/hello.get.ts → GET /hello
export default get(() => "Hello World");
\`\`\`

\`\`\`ts
// src/routes/hello.get.ts → GET /hello (same route, named export)
export const httpGet = get(() => "Hello World");
\`\`\`

Both compile to the same fast \`Bun.serve\` route table.
${authSection}
## Routes

Routes live in \`src/routes\`.

Examples:

- \`src/routes/index.get.ts\` → \`GET /\`
- \`src/routes/health.get.ts\` → \`GET /health\`
- \`src/routes/products/[id].get.ts\` → \`GET /products/:id\`
`;
}

export function pluginsTemplate(opts: { features: ReadonlySet<Feature> }): string {
  const selected = PLUGIN_FEATURES.filter((feature) => opts.features.has(feature));

  if (selected.length === 0) {
    return `export const plugins: never[] = [];\n`;
  }

  const coreSymbols = selected
    .filter((feature) => !["auth", "mailer", "realtime", "rpc"].includes(feature))
    .map((feature) => (feature === "metrics" ? "metricsPlugin" : feature));
  const imports =
    coreSymbols.length > 0 ? [`{ ${coreSymbols.join(", ")} } from "@ignex/core"`] : [];
  for (const feature of selected) {
    for (const extra of PLUGIN_EMISSIONS[feature]?.imports ?? []) imports.push(extra);
  }
  const calls = selected.map((feature) => PLUGIN_EMISSIONS[feature]?.call ?? `${feature}()`);

  // Emit an ARRAY (not composePlugins(...)) — the compiler and
  // pluginsToLifeCycle iterate the plugins array; a composed single object is
  // non-iterable and would crash at build time.
  return `import ${imports.join(";\nimport ")};

export const plugins = [
  ${calls.join(",\n  ")}
];
`;
}
