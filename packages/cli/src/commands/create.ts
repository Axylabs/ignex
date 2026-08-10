import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  biomeTemplate,
  fluxConfigTemplate,
  gitignoreTemplate,
  hasPluginFeatures,
  packageJsonTemplate,
  pluginsTemplate,
  readmeTemplate,
  tsconfigTemplate,
} from "../templates/project.js";
import {
  appConfigTemplate,
  cacheRouteTemplate,
  clusterExampleTemplate,
  envRouteTemplate,
  healthRouteTemplate,
  homeTemplate,
  i18nRouteTemplate,
  indexRouteTemplate,
  jobsRouteTemplate,
  layoutTemplate,
  loginRouteTemplate,
  meRouteTemplate,
  openApiRouteTemplate,
  pageRouteTemplate,
  productAddRouteTemplate,
  productByIdRouteTemplate,
  proxyRouteTemplate,
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

type Readline = ReturnType<typeof createInterface>;

export async function runCreate(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      name: { type: "string" },
      runtime: { type: "string" },
      pm: { type: "string" },
      features: { type: "string" },
      install: { type: "boolean" },
      git: { type: "boolean" },
      yes: { type: "boolean" },
      force: { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
  });

  const interactive = Boolean(process.stdin.isTTY && !values.yes);

  let name = positionals[0] ?? (values.name as string | undefined);
  let runtimeInput = values.runtime as string | undefined;
  let pmInput = values.pm as string | undefined;
  let featuresInput = values.features as string | undefined;
  let install = values.install as boolean | undefined;
  let git = values.git as boolean | undefined;

  if (interactive) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      if (!name) {
        name = await ask(rl, "Project name", "flux-app");
      }

      if (!runtimeInput) {
        runtimeInput = await ask(rl, "Runtime (bun/node)", "bun");
      }

      if (!pmInput) {
        pmInput = await ask(
          rl,
          "Package manager (bun/npm/pnpm/yarn)",
          runtimeInput === "node" ? "npm" : "bun",
        );
      }

      if (!featuresInput) {
        featuresInput = await ask(
          rl,
          "Features (all, none, or comma-separated)",
          "openapi,examples,tests",
        );
      }

      if (install === undefined) {
        install = await askConfirm(rl, "Install dependencies?", true);
      }

      if (git === undefined) {
        git = await askConfirm(rl, "Initialize git?", true);
      }
    } finally {
      rl.close();
    }
  }

  name = name ?? "flux-app";

  const runtime = normalizeRuntime(runtimeInput);
  const pm = normalizePm(pmInput, runtime);

  const features = parseFeatures(featuresInput ?? (values.yes ? "openapi,examples,tests" : "none"));

  install = install ?? false;
  git = git ?? false;

  const target = resolve(process.cwd(), name);

  if (await exists(target)) {
    if (!(await isDirEmpty(target)) && !values.force) {
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
  };

  await writeFileEnsuringDir(join(target, "package.json"), packageJsonTemplate(opts));
  await writeFileEnsuringDir(join(target, "tsconfig.json"), tsconfigTemplate(opts));
  await writeFileEnsuringDir(join(target, "flux.config.mjs"), fluxConfigTemplate());
  await writeFileEnsuringDir(join(target, "biome.json"), biomeTemplate());
  await writeFileEnsuringDir(join(target, ".gitignore"), gitignoreTemplate());
  await writeFileEnsuringDir(join(target, "README.md"), readmeTemplate(opts));

  await writeFileEnsuringDir(join(target, "src/routes/index.get.ts"), indexRouteTemplate(name));

  await writeFileEnsuringDir(join(target, "src/routes/health.get.ts"), healthRouteTemplate());

  await writeFileEnsuringDir(
    join(target, "src/hooks/README.md"),
    `# Hooks

Place shared hooks here.
`,
  );

  if (features.has("openapi")) {
    await writeFileEnsuringDir(
      join(target, "src/routes/openapi.json.get.ts"),
      openApiRouteTemplate(name),
    );
  }

  if (features.has("examples")) {
    await writeFileEnsuringDir(
      join(target, "src/routes/products/[id].get.ts"),
      productByIdRouteTemplate(),
    );

    await writeFileEnsuringDir(
      join(target, "src/routes/products/add.post.ts"),
      productAddRouteTemplate(),
    );
  }

  if (features.has("files")) {
    await writeFileEnsuringDir(join(target, "src/routes/upload.post.ts"), uploadRouteTemplate());
  }

  if (features.has("sse")) {
    await writeFileEnsuringDir(join(target, "src/routes/events.get.ts"), sseRouteTemplate());
  }

  if (features.has("cache")) {
    await writeFileEnsuringDir(join(target, "src/routes/cached.get.ts"), cacheRouteTemplate());
  }

  if (features.has("proxy")) {
    await writeFileEnsuringDir(join(target, "src/routes/proxy.get.ts"), proxyRouteTemplate());
  }

  if (hasPluginFeatures(features)) {
    await writeFileEnsuringDir(join(target, "src/plugins/index.ts"), pluginsTemplate(opts));
  }

  if (features.has("ws")) {
    await writeFileEnsuringDir(join(target, "src/ws.example.ts"), wsExampleTemplate());
  }

  if (features.has("cluster")) {
    await writeFileEnsuringDir(join(target, "src/cluster.example.ts"), clusterExampleTemplate());
  }

  if (features.has("auth")) {
    await writeFileEnsuringDir(
      join(target, "src/hooks/require-auth.ts"),
      requireAuthHookTemplate(),
    );
    await writeFileEnsuringDir(join(target, "src/routes/auth/login.post.ts"), loginRouteTemplate());
    await writeFileEnsuringDir(join(target, "src/routes/auth/me.get.ts"), meRouteTemplate());
  }

  if (features.has("sessions")) {
    await writeFileEnsuringDir(join(target, "src/routes/session.get.ts"), sessionRouteTemplate());
  }

  if (features.has("sessions") || features.has("auth") || hasPluginFeatures(features)) {
    await writeFileEnsuringDir(join(target, "src/app.config.ts"), appConfigTemplate());
  }

  if (features.has("templates")) {
    await writeFileEnsuringDir(join(target, "src/views/layout.html"), layoutTemplate());
    await writeFileEnsuringDir(join(target, "src/views/home.html"), homeTemplate());
    await writeFileEnsuringDir(join(target, "src/routes/page.get.ts"), pageRouteTemplate());
  }

  if (features.has("i18n")) {
    await writeFileEnsuringDir(join(target, "src/routes/i18n.get.ts"), i18nRouteTemplate());
  }

  if (features.has("env")) {
    await writeFileEnsuringDir(join(target, "src/routes/env.get.ts"), envRouteTemplate());
  }

  if (features.has("jobs")) {
    await writeFileEnsuringDir(join(target, "src/routes/jobs.get.ts"), jobsRouteTemplate());
  }

  if (features.has("tests")) {
    await writeFileEnsuringDir(join(target, "vitest.config.ts"), vitestConfigTemplate());
    await writeFileEnsuringDir(join(target, "test/app.test.ts"), testTemplate());
  }

  if (git) {
    const result = spawnSync("git", ["init"], {
      cwd: target,
      stdio: "ignore",
    });

    if (result.error) {
      warn(`Could not initialize git: ${result.error.message}`);
    }
  }

  if (install) {
    const result = spawnSync(pm, ["install"], {
      cwd: target,
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    if (result.error) {
      warn(`Could not run ${pm} install: ${result.error.message}`);
    }
  }

  const rel = relative(process.cwd(), target) || ".";

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

function ask(rl: Readline, question: string, fallback: string): Promise<string> {
  return rl.question(`${question} (${fallback}): `).then((answer) => {
    const trimmed = answer.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  });
}

async function askConfirm(rl: Readline, question: string, fallback: boolean): Promise<boolean> {
  const suffix = fallback ? "(Y/n)" : "(y/N)";
  const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();

  if (!answer) return fallback;

  return answer.startsWith("y");
}

function normalizeRuntime(input?: string): "bun" | "node" {
  return input?.toLowerCase() === "node" ? "node" : "bun";
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
  security: "security",
  compression: "compression",
  logger: "logger",
  logs: "logger",
  openapi: "openapi",
  files: "files",
  upload: "files",
  ws: "ws",
  websocket: "ws",
  sse: "sse",
  cache: "cache",
  proxy: "proxy",
  cluster: "cluster",
  examples: "examples",
  tests: "tests",
  test: "tests",
};

function parseFeatures(input: string | undefined): Set<Feature> {
  if (!input) return new Set();

  const normalized = input.trim().toLowerCase();

  if (normalized === "all") {
    return new Set(FEATURE_NAMES);
  }

  if (normalized === "none" || normalized === "") {
    return new Set();
  }

  const out = new Set<Feature>();

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

  return out;
}
