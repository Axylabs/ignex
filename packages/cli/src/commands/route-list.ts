/**
 * `ignex route:list` — pretty route table for an ignex app.
 *
 * Laravel's `php artisan route:list` equivalent. Reads the AOT compiler's
 * `manifest.json` (paths `manifest.json` under the configured outDir, or
 * `dist/manifest.json`) and prints one row per route: method, path, source
 * file, dynamic/static, constant response, response type, and hotness.
 *
 *   ignex route:list            → table from the built manifest
 *   ignex route:list --json     → machine-readable JSON
 *   ignex route:list --methods GET,POST → filter by method
 *
 * When no manifest exists (not built yet) it prints the route FILES under
 * the routes dir with their inferred method+path instead, so the command is
 * useful before the first build too.
 */

import type { Dirent } from "node:fs";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type ArgsDef, defineCommand, parseArgs } from "citty";
import { loadConfig } from "../utils/config.js";
import { resolveProjectRoot } from "../utils/discover-root.js";
import { error } from "../utils/logger.js";
import { padAnsi, stringWidth } from "../utils/terminal.js";
import { metaFor } from "./registry.js";

/** One row of the route table. */
interface RouteRow {
  method: string;
  path: string;
  file: string;
  kind: "static" | "dynamic";
  constant?: boolean;
  responseType?: string;
  hotness?: number;
}

/** A compiled manifest entry (subset of the compiler's manifest shape). */
interface ManifestRoute {
  method: string;
  path: string;
  file: string;
  isDynamic?: boolean;
  isConstantResponse?: boolean;
  responseType?: string;
  hotnessScore?: number;
}

/** Parse `products/[id].get.ts` → { method: "GET", path: "products/:id" }. */
export function routeFromFile(file: string): { method: string; path: string } | null {
  const m = /^(.*)\.(get|post|put|patch|del|delete|options|head|all)\.(ts|tsx|js|mjs)$/.exec(file);
  if (!m) return null;
  const method = m[2] === "del" ? "DELETE" : (m[2] ?? "GET").toUpperCase();
  const rawPath = m[1] ?? "";
  const path = rawPath
    .replace(/^index$/, "")
    .replace(/\[\.\.\.([^\]]+)\]/g, "*$1")
    .replace(/\[([^\]]+)\]/g, ":$1")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
  return { method, path: `/${path}`.replace(/\/+$/, "") || "/" };
}

/** Infer rows from route FILES (no manifest yet). */
function rowsFromFiles(routesDir: string): RouteRow[] {
  const rows: RouteRow[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, `${prefix}${entry.name}/`);
        continue;
      }
      const rel = `${prefix}${entry.name}`;
      const parsed = routeFromFile(rel);
      if (!parsed) continue;
      rows.push({
        method: parsed.method,
        path: parsed.path,
        file: rel,
        kind: rel.includes("[") ? "dynamic" : "static",
      });
    }
  };
  walk(routesDir, "");
  return rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** Read + shape rows from the compiled manifest. */
function rowsFromManifest(manifestPath: string): RouteRow[] {
  let manifest: { routes?: ManifestRoute[] };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { routes?: ManifestRoute[] };
  } catch (err) {
    throw new Error(
      `Cannot read manifest ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const routes = manifest.routes ?? [];
  return routes.map((r) => ({
    method: r.method,
    path: r.path,
    file: r.file,
    kind: r.isDynamic ? "dynamic" : "static",
    constant: r.isConstantResponse,
    responseType: r.responseType,
    hotness: r.hotnessScore,
  }));
}

/** Find the manifest under the configured outDir (default `dist`). */
function findManifest(root: string, config: { outDir?: string }): string | null {
  const outDir = config.outDir ?? "dist";
  for (const candidate of [
    join(root, outDir, "manifest.json"),
    join(root, "dist", "manifest.json"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Render a padded ASCII table (display-width aware via Bun.stringWidth). */
export function renderTable(rows: RouteRow[], root: string): string {
  if (rows.length === 0) return "(no routes)";
  const width = (key: (r: RouteRow) => string) =>
    Math.max(
      ...rows.map((r) => stringWidth(key(r))),
      ...["METHOD", "PATH", "FILE"].map((h) => stringWidth(h)),
    );
  const mw = width((r) => r.method);
  const pw = width((r) => r.path);
  const fw = width((r) => r.file);
  const head = `${padAnsi("METHOD", mw)}  ${padAnsi("PATH", pw)}  ${padAnsi("FILE", fw)}  KIND      RESPONSE   HOT`;
  const lines = [head, "-".repeat(stringWidth(head))];
  for (const r of rows) {
    const kind = r.kind === "dynamic" ? "dynamic" : "static";
    const resp = r.constant ? "constant" : (r.responseType ?? "—");
    lines.push(
      `${padAnsi(r.method, mw)}  ${padAnsi(r.path, pw)}  ${padAnsi(relative(root, r.file), fw)}  ${padAnsi(kind, 10)} ${padAnsi(resp, 9)} ${String(r.hotness ?? "—")}`,
    );
  }
  return lines.join("\n");
}

/** Typed CLI surface shared by parsing and usage rendering. */
const argsDef = {
  root: { type: "string", valueHint: "dir", description: "Project root" },
  json: { type: "boolean", description: "Machine-readable JSON output" },
  methods: {
    type: "string",
    valueHint: "GET,POST",
    description: "Filter by method (comma-separated)",
  },
  match: {
    type: "string",
    description: "Only show routes whose path contains this substring",
  },
} satisfies ArgsDef;

export const routeListCmd = defineCommand({
  meta: metaFor("route:list"),
  args: argsDef,
  async run(ctx) {
    await runRouteList(ctx.rawArgs);
  },
});

export default routeListCmd;

export async function runRouteList(args: string[]): Promise<void> {
  const parsed = parseArgs<typeof argsDef>(args, argsDef);
  const root = await resolveProjectRoot(parsed.root);
  const config = await loadConfig(root);

  let rows: RouteRow[];
  const manifest = findManifest(root, config);
  if (manifest) {
    try {
      rows = rowsFromManifest(manifest);
    } catch (err) {
      error((err as Error).message);
      rows = [];
    }
  } else {
    const cfg = config as Record<string, unknown>;
    const routesDir = join(root, typeof cfg.routesDir === "string" ? cfg.routesDir : "src/routes");
    rows = rowsFromFiles(routesDir);
  }

  if (parsed.methods) {
    const wanted = String(parsed.methods)
      .split(",")
      .map((m) => m.trim().toUpperCase())
      .filter(Boolean);
    rows = rows.filter((r) => wanted.includes(r.method));
  }

  if (parsed.match) {
    const needle = parsed.match.toLowerCase();
    rows = rows.filter(
      (r) => r.path.toLowerCase().includes(needle) || r.file.toLowerCase().includes(needle),
    );
  }

  if (parsed.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log(renderTable(rows, root));
  console.log(
    `\n${rows.length} route(s) — source: ${manifest ? "manifest.json" : "routes dir (not built yet; run ignex build)"}`,
  );
}
