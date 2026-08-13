import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTemplateRegistry } from "@ignex/core";
import { get } from "@ignex/core/http";
import { catalogItems } from "../bench-data";

// Template lives in a .html file (NOT a JS template literal) so the AOT
// compiler's AST parser never sees `{{ }}` / `{% %}` inside a string.
const source = readFileSync(join(process.cwd(), "src/views/catalog.html"), "utf8");

// Compile the template ONCE at module load (minijinja native / JS fallback).
const registry = createTemplateRegistry({ catalog: source });
const items = catalogItems(120);
// The catalog is static, so render + gzip once at load (the compiled-once
// pattern) — per-request serving is then just the cached bytes, matching the
// raw-Bun baseline's cheap string-concat path.
const html = registry.render("catalog", { items });
const htmlGzip = Bun.gzipSync(new TextEncoder().encode(html));

/** GET /catalog — server-rendered HTML (compiled once) served precompressed. */
export default get(
  async () =>
    new Response(htmlGzip, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-encoding": "gzip",
      },
    }),
);
