/**
 * `ignex event [kind] [name]` — event-driven scaffolding wizard.
 *
 *   ignex event                          → interactive wizard (kind + name)
 *   ignex event sse orders               → SSE stream at GET /events/orders
 *   ignex event webhook orders           → webhook receiver at POST /hooks/orders
 *   ignex event bus order                → typed event bus + publish route +
 *                                          example consumer module
 *
 * Every flow scaffolds the business logic into `src/modules/` (or
 * `src/lib/events.ts` for the bus) and keeps the route file a thin HTTP layer.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type ArgsDef, defineCommand, parseArgs } from "citty";
import {
  EVENT_KINDS,
  type EventKind,
  eventFiles,
  eventSummary,
  validateEventName,
} from "../templates/event.js";
import { loadConfig } from "../utils/config.js";
import { resolveProjectRoot } from "../utils/discover-root.js";
import { error, info, step, success } from "../utils/logger.js";
import { PromptCancelError, promptConfirm, promptSelect, promptText } from "../utils/prompt.js";
import { emitRealtimeArtifact } from "../utils/realtime-artifact.js";
import { resolveDir, writeScaffold } from "../utils/scaffold.js";
import { metaFor } from "./registry.js";

/** True when the raw value is a known event kind. */
const isKind = (value: string): value is EventKind =>
  (EVENT_KINDS as readonly string[]).includes(value);

/** Typed CLI surface shared by parsing and usage rendering. */
const argsDef = {
  // Flags mirror the positionals (`ignex event <kind> <name>`); both forms are
  // accepted and the positional wins when both are given.
  kind: {
    type: "string",
    valueHint: "sse|webhook|bus",
    description: "Event flow kind (same as the first positional)",
  },
  name: {
    type: "string",
    description: "Kebab-case event name (same as the second positional)",
  },
  root: { type: "string", valueHint: "dir", description: "Project root" },
  force: { type: "boolean", description: "Overwrite existing files" },
} satisfies ArgsDef;

export const eventCmd = defineCommand({
  meta: metaFor("event"),
  args: argsDef,
  async run(ctx) {
    await runEvent(ctx.rawArgs);
  },
});

export default eventCmd;

/** Resolve the event kind from the positional or a wizard select. */
async function resolveKind(
  parsed: ReturnType<typeof parseArgs> | Record<string, unknown>,
): Promise<EventKind | undefined> {
  const raw =
    (parsed.kind as string | undefined) ||
    ((parsed._ as readonly string[])[0] as string | undefined);
  if (raw !== undefined) {
    if (!isKind(raw)) {
      error(`Unknown event kind "${raw}". Expected one of: ${EVENT_KINDS.join(", ")}.`);
      process.exitCode = 1;
      return undefined;
    }
    return raw;
  }
  if (process.stdin.isTTY) {
    try {
      const picked = await promptSelect({
        message: "What kind of event flow do you need?",
        options: [
          {
            value: "sse",
            label: "SSE stream",
            hint: "server pushes events to clients (GET /events/<name>)",
          },
          {
            value: "webhook",
            label: "Webhook receiver",
            hint: "receives event data from clients (POST /hooks/<name>)",
          },
          {
            value: "bus",
            label: "Event bus",
            hint: "typed in-process pub/sub + publish route + consumer",
          },
        ],
        initial: "webhook",
      });
      if (isKind(picked)) return picked;
    } catch (err) {
      if (err instanceof PromptCancelError) return undefined;
      throw err;
    }
  }
  error(`Event kind is required. Use: ignex event ${EVENT_KINDS.join(" | ")} <name>`);
  process.exitCode = 1;
  return undefined;
}

/** Resolve the event name from the second positional or a wizard input. */
async function resolveName(
  parsed: ReturnType<typeof parseArgs> | Record<string, unknown>,
): Promise<string | undefined> {
  let name = (parsed.name as string | undefined) ?? (parsed._ as readonly string[])[1];
  if (!name && process.stdin.isTTY) {
    try {
      name = await promptText({
        message: "Event name (kebab-case, e.g. order-created)",
        initial: "",
        validate: (value) => (value.length === 0 ? "Name is required." : validateEventName(value)),
      });
    } catch (err) {
      if (err instanceof PromptCancelError) return undefined;
      throw err;
    }
  }
  if (!name) {
    error("Event name is required (e.g. ignex event sse orders).");
    process.exitCode = 1;
    return undefined;
  }
  const problem = validateEventName(name);
  if (problem) {
    error(problem);
    process.exitCode = 1;
    return undefined;
  }
  return name;
}

export async function runEvent(args: string[]): Promise<void> {
  const parsed = parseArgs<typeof argsDef>(args, argsDef);

  // Positionals are [kind, name], never a project root.
  const root = await resolveProjectRoot(parsed.root);

  const kind = await resolveKind(parsed);
  if (!kind) return;
  const name = await resolveName(parsed);
  if (!name) return;

  const config = await loadConfig(root);
  const srcDir = join(root, "src");
  const routesDir = resolveDir(root, undefined, config.routesDir, "src/routes");

  step(`Scaffolding ${kind} flow "${name}"`);

  let wroteAny = false;
  for (const { path, content } of eventFiles(kind, name)) {
    // Bus files live in src/lib + src/modules; route files resolve against the
    // configured routes dir so custom layouts keep working.
    const target = path.startsWith("routes/")
      ? join(routesDir, path.slice("routes/".length))
      : join(srcDir, path);
    const ok = await writeScaffold(target, content, { force: parsed.force === true });
    wroteAny = wroteAny || ok;
  }

  if (wroteAny) {
    success(eventSummary(kind, name));
    if (kind === "bus") {
      // The bus flow needs the generated wire stack — make it available
      // right away: tsconfig include + (best-effort) local SDK generation.
      await ensureTsconfigSdkInclude(root);
      await ensureLocalRealtimeSdk(root);
      await maybeInstallNova(root);
      printBusWiring();
    } else {
      info(`Business logic lives in src/modules/ — routes stay thin.`);
    }
  }
}

/** Add `.ignex/sdk` to the project's tsconfig `include` (idempotent). */
async function ensureTsconfigSdkInclude(root: string): Promise<void> {
  const tsconfigPath = join(root, "tsconfig.json");
  try {
    const raw = await readFile(tsconfigPath, "utf-8");
    const cfg = JSON.parse(raw) as { include?: string[] };
    const include = cfg.include ?? [];
    if (!include.includes(".ignex/sdk")) {
      cfg.include = [...include, ".ignex/sdk"];
      await writeFile(tsconfigPath, `${JSON.stringify(cfg, null, 2)}\n`);
      info('Added ".ignex/sdk" to tsconfig include (generated SDK types).');
    }
  } catch {
    info('Tip: add ".ignex/sdk" to your tsconfig include to type the generated SDK.');
  }
}

/**
 * Generate the local realtime SDK (bindings + typed facade) right after
 * scaffolding, so the emitted route/consumer typecheck immediately.
 * Best-effort: when @ignex/nova/generate or `flatc` is missing, falls back
 * to the "run ignex build" instruction (build also regenerates the SDK).
 */
async function ensureLocalRealtimeSdk(root: string): Promise<void> {
  try {
    const config = await loadConfig(root);
    const outDir = (config.outDir as string | undefined) ?? ".ignex";
    const absolute = isAbsolute(outDir) ? outDir : join(root, outDir);
    if (await emitRealtimeArtifact(root, absolute)) {
      const { ensureLocalRealtimeSdk: ensureSdk } = await import("../utils/realtime-artifact.js");
      if (await ensureSdk(root, absolute)) {
        info(`Generated local realtime SDK in ${join(absolute, "sdk")}.`);
      }
    }
  } catch (err) {
    info(
      "Could not generate the local SDK yet — run `ignex build` after adding the plugin " +
        `(it regenerates the SDK). ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Print the exact app.config wiring for the bus flow. */
function printBusWiring(): void {
  console.log();
  console.log("Next steps — wire the plugin into src/app.config.ts:");
  console.log('  1. import { realtimePlugin } from "./realtime.plugin.js";');
  console.log("  2. add `realtimePlugin` to the `plugins` array.");
  console.log();
  console.log("Then: bun run build   (regenerates .ignex/sdk + the compiled server)");
  console.log("      bun run dev");
  console.log();
  console.log(
    "FE side: the generated SDK (`.ignex/sdk/realtime`) ships `createRealtimeClient(url)` — " +
      "a typed, pure-JS FlatBuffers client. Publish it for your FE team with " +
      "`ignex sdk --platform realtime`.",
  );
}

/**
 * Offer to add the `@ignex/nova` dependency when the bus scaffold needs it and
 * the project doesn't have it yet (the realtime transport backing the typed
 * events file). Mirrors `maybeInstallTypebox` in `route.ts`.
 */
async function maybeInstallNova(root: string): Promise<void> {
  const pkgPath = join(root, "package.json");
  let hasNova = false;
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    hasNova = Boolean(pkg.dependencies?.["@ignex/nova"] ?? pkg.devDependencies?.["@ignex/nova"]);
  } catch {
    // No package.json — leave the hint only.
  }

  if (!hasNova && process.stdin.isTTY) {
    try {
      const install = await promptConfirm({ message: "Add @ignex/nova?", initial: true });
      if (install) {
        const pm = detectPm(root);
        const result = spawnSync(pm, ["add", "@ignex/nova"], {
          cwd: root,
          stdio: "inherit",
        });
        if (result.status === 0) {
          success("Installed @ignex/nova.");
        }
      }
    } catch {
      // cancelled — the hint below still explains the manual step
    }
  } else if (!hasNova) {
    info("  Install it if missing: bun add @ignex/nova");
  }
}

/** Best-effort package manager detection from lockfiles, defaulting to bun. */
const detectPm = (root: string): "bun" | "npm" | "pnpm" | "yarn" => {
  const has = (f: string): boolean => existsSync(join(root, f));
  if (has("bun.lock") || has("bun.lockb")) return "bun";
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  if (has("package-lock.json")) return "npm";
  return "bun";
};
