/** @fileoverview Pure Markdown presentation of the collected KT snapshot. */

import { spanKindNames } from "./span-kind-names";
import type { AppKnowledge } from "./types";

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
