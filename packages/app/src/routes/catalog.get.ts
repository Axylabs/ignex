import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTemplateRegistry } from "@ignus/core";
import { get } from "@ignus/core/http";
import { catalogItems } from "../bench-data";

// Template lives in a .html file (NOT a JS template literal) so the AOT
// compiler's AST parser never sees `{{ }}` / `{% %}` inside a string.
const source = readFileSync(join(process.cwd(), "src/views/catalog.html"), "utf8");

// Compiled once at module load (minijinja native / JS fallback); per-request
// rendering of the 120-item catalog is what's measured.
const registry = createTemplateRegistry({ catalog: source });
const items = catalogItems(120);

/** GET /catalog — server-rendered HTML via a loop template over real items. */
export default get(async (ctx) => ctx.html(registry.render("catalog", { items })));
