/**
 * @fileoverview Debugbar SPA builder — compiles the SolidJS + Tailwind UI
 * sources under `packages/core/src/debug/ui/` into a single self-contained
 * client artifact and emits it as a committed TS module
 * (`dashboard-client.gen.ts`) that the serving plugin ships without any
 * runtime build step.
 *
 * Pipeline (all ahead of time, verified in CI):
 *   1. Babel (babel-preset-solid + @babel/preset-typescript) compiles every
 *      `.tsx` source into fine-grained reactive DOM code (the Solid compiler).
 *   2. `@tailwindcss/cli` scans the sources and builds the tokenized
 *      design system (`ui/styles.css` → app.css).
 *   3. `Bun.build` bundles the transformed entry into one classic-script IIFE.
 *
 * This is the AOT-first approach to client assets: the bundle is produced
 * ahead of time (and verified in CI), so the dev server never pays for a
 * bundler at request time and published packages stay source-only.
 *
 * Usage:
 *   bun scripts/gen-debug-ui.ts           # regenerate the artifact
 *   bun scripts/gen-debug-ui.ts --check   # verify freshness (CI gate; exit 1 on drift)
 */

import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { transformSync } from "@babel/core";
import presetTs from "@babel/preset-typescript";
import presetSolid from "babel-preset-solid";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const UI_DIR = join(ROOT, "packages/core/src/debug/ui");
const OUT_FILE = join(ROOT, "packages/core/src/debug/dashboard-client.gen.ts");
const TAILWIND_CLI = join(ROOT, "node_modules/@tailwindcss/cli/dist/index.mjs");

const checkOnly = process.argv.includes("--check");

/** Recursively list `.tsx` files under `dir`. */
const listTsx = (dir: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listTsx(path));
    else if (entry.name.endsWith(".tsx")) files.push(path);
  }
  return files;
};

/**
 * Stage the UI sources into `buildDir`: every `.tsx` goes through the Solid
 * compiler (reactive DOM output) and is rewritten as `.js`; `.ts`/`.css`
 * sources are copied verbatim for the bundler to pick up.
 */
const stageSources = (buildDir: string): void => {
  cpSync(UI_DIR, buildDir, { recursive: true });
  for (const file of listTsx(buildDir)) {
    const code = readFileSync(file, "utf8");
    const out = transformSync(code, {
      filename: file,
      presets: [presetTs, [presetSolid, { generate: "dom" }]],
      babelrc: false,
      configFile: false,
      comments: false,
      compact: false,
    });
    if (out?.code === undefined || out.code === null) {
      throw new Error(`gen-debug-ui: babel produced no output for ${file}`);
    }
    writeFileSync(file.replace(/\.tsx$/, ".js"), out.code);
    rmSync(file);
  }
};

/** Build the dashboard stylesheet with the Tailwind CLI. */
const buildCss = async (outCss: string): Promise<void> => {
  const proc = Bun.spawn(
    [
      "bun",
      TAILWIND_CLI,
      "-i",
      join(UI_DIR, "styles.css"),
      "-o",
      outCss,
      "--minify",
      "--cwd",
      ROOT,
      "--silent",
    ],
    { env: process.env, stdout: "pipe", stderr: "pipe" },
  );
  const exit = await proc.exited;
  if (exit !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`gen-debug-ui: tailwind failed (${String(exit)})\n${err}`);
  }
};

/** Bundle the staged entry into one classic-script IIFE (browser target). */
const buildClientJs = async (entry: string): Promise<string> => {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "iife",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!result.success) {
    const problems = result.logs.map((log) => String(log)).join("\n");
    throw new Error(`gen-debug-ui: bundle failed\n${problems}`);
  }
  const jsArtifact = result.outputs.find((out) => out.kind === "entry-point");
  if (!jsArtifact) throw new Error("gen-debug-ui: no entry-point output produced");
  return await jsArtifact.text();
};

/** Escape arbitrary source text for safe embedding in a TS template literal. */
const embed = (text: string): string =>
  text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

/** Build everything and return the generated artifact body. */
const buildArtifact = async (): Promise<string> => {
  // Workspace-local staging dir (cleaned up below): /tmp may be unusual on
  // some setups and the bundler reads these files back within the same run.
  const buildDir = mkdtempSync(join(ROOT, ".gen-debug-ui-"));
  try {
    stageSources(buildDir);
    const cssPath = join(buildDir, "app.css");
    await buildCss(cssPath);
    const js = await buildClientJs(join(buildDir, "index.js"));
    const css = readFileSync(cssPath, "utf8");
    const hash = createHash("sha256").update(`${js}\u0000${css}`).digest("hex").slice(0, 16);

    const banner = [
      "/* eslint-disable */",
      "// GENERATED FILE — do not edit by hand.",
      "// Source of truth: packages/core/src/debug/ui/ (regenerate: bun run gen:debug-ui).",
      `// Content hash: ${hash}`,
      "",
    ].join("\n");

    return `${banner}/**
 * Bundled debugbar dashboard JavaScript (classic-script IIFE; served at
 * \`{path}/app.js\`). The mount path is injected at serve time via the
 * script tag's \`data-base\` attribute.
 */
export const DEBUGBAR_CLIENT_JS = \`${embed(js)}\`;

/**
 * Dashboard stylesheet (served at \`{path}/app.css\`). Tokenized dark/light
 * design system — see ui/styles.css for the readable Tailwind source.
 */
export const DEBUGBAR_CLIENT_CSS = \`${embed(css)}\`;

/** Short content hash of the JS+CSS payload — used as the static ETag. */
export const DEBUGBAR_CLIENT_HASH = "${hash}";
`;
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
};

const body = await buildArtifact();

if (checkOnly) {
  let current: string;
  try {
    current = readFileSync(OUT_FILE, "utf8");
  } catch {
    console.error("gen-debug-ui --check: generated artifact missing — run `bun run gen:debug-ui`.");
    process.exit(1);
  }
  if (current !== body) {
    console.error(
      "gen-debug-ui --check: dashboard-client.gen.ts is stale relative to packages/core/src/debug/ui/ — run `bun run gen:debug-ui`.",
    );
    process.exit(1);
  }
  console.log(`gen-debug-ui: up to date (${DEBUGBAR_HASH(body)})`);
  process.exit(0);
}

writeFileSync(OUT_FILE, body);
const jsSize = (body.match(/DEBUGBAR_CLIENT_JS = `([\s\S]*?)`;/) ?? [])[1]?.length ?? 0;
const cssSize = (body.match(/DEBUGBAR_CLIENT_CSS = `([\s\S]*?)`;/) ?? [])[1]?.length ?? 0;
console.log(
  `gen-debug-ui: wrote ${OUT_FILE.replace(`${ROOT}/`, "")} (${(jsSize / 1024).toFixed(1)} KiB js, ${(cssSize / 1024).toFixed(1)} KiB css, hash ${DEBUGBAR_HASH(body)})`,
);

/** Extract the content hash embedded in a generated artifact body. */
function DEBUGBAR_HASH(bodyText: string): string {
  return bodyText.match(/DEBUGBAR_CLIENT_HASH = "([0-9a-f]+)";/)?.[1] ?? "?";
}
