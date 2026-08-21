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
import { join } from "node:path";
import {
  EVENT_KINDS,
  type EventKind,
  eventFiles,
  eventSummary,
  validateEventName,
} from "../templates/event.js";
import { parseCliArgs, resolveRoot } from "../utils/args.js";
import { loadConfig } from "../utils/config.js";
import { error, info, step, success } from "../utils/logger.js";
import { PromptCancelError, promptSelect, promptText } from "../utils/prompt.js";
import { resolveDir, writeScaffold } from "../utils/scaffold.js";

const isKind = (value: string): value is EventKind =>
  (EVENT_KINDS as readonly string[]).includes(value);

/** Resolve the event kind from `--kind`, the positional, or a wizard select. */
async function resolveKind(
  values: Record<string, unknown>,
  positionals: readonly string[],
): Promise<EventKind | undefined> {
  const raw = (values.kind as string | undefined) ?? positionals[0];
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

/** Resolve the event name from `--name`, the positional, or a wizard input. */
async function resolveName(
  values: Record<string, unknown>,
  positionals: readonly string[],
): Promise<string | undefined> {
  let name = (values.name as string | undefined) ?? positionals[1];
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
  const { values, positionals } = parseCliArgs(args, {
    root: { type: "string" },
    kind: { type: "string" },
    name: { type: "string" },
    force: { type: "boolean" },
  });

  // Positionals are [kind, name], never a project root.
  const root = resolveRoot(values, positionals, { ignorePositionals: true });

  const kind = await resolveKind(values, positionals);
  if (!kind) return;
  const name = await resolveName(values, positionals);
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
    const ok = await writeScaffold(target, content, { force: Boolean(values.force) });
    wroteAny = wroteAny || ok;
  }

  if (wroteAny) {
    success(eventSummary(kind, name));
    if (kind === "bus") {
      info("Wire the consumer from your app bootstrap (e.g. src/app.config.ts).");
    } else {
      info(`Business logic lives in src/modules/ — routes stay thin.`);
    }
  }
}
