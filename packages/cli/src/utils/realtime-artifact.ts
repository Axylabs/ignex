/**
 * @fileoverview `realtime.json` artifact emission for `ignex build` / `ignex sdk`.
 *
 * Artifact contract (consumed by the compiler's realtime SDK platform): an
 * app opts into realtime codegen by exporting a `realtime` object from
 * `<root>/src/realtime.ts`:
 *
 * ```ts
 * // src/realtime.ts
 * import { Type } from "@sinclair/typebox";
 *
 * export const realtime = {
 *   subjectPrefix: "safo",                        // optional, default: pkg name w/o scope
 *   schemas: { ChatMessage: Type.Object({ ... }) }, // optional named tables
 *   events: { "chat.message": ChatMessage },        // required, non-empty
 *   controlEvents: {},                              // optional extra control events
 * };
 * ```
 *
 * This module serializes it to `<outDir>/realtime.json`; the runtime RPC kit
 * may additionally write `<outDir>/rpc-manifest.json`
 * (`{ methods: { "<method.name>": <args schema> } }`), which the SDK loader
 * merges into the generation context.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The serialized `realtime.json` artifact (fixed key order for determinism). */
interface RealtimeArtifact {
  subjectPrefix: string;
  schemas?: Record<string, unknown>;
  events: Record<string, unknown>;
  controlEvents?: Record<string, unknown>;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Default subject prefix: the package.json "name" without its npm scope,
 * falling back to "ignex" when no usable name exists.
 */
const defaultSubjectPrefix = async (root: string): Promise<string> => {
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      name?: unknown;
    };
    if (typeof pkg.name === "string") {
      const unscoped = pkg.name.split("/").pop() ?? "";
      if (unscoped !== "") return unscoped;
    }
  } catch {
    // No readable package.json — fall through to the framework default.
  }
  return "ignex";
};

/** Monotonic counter so repeat loads never hit Bun's module cache. */
let importSeq = 0;

/**
 * Emit `<outDir>/realtime.json` from `<root>/src/realtime.ts`.
 *
 * Reads the module's `realtime` named export (object; `events` must be a
 * non-empty record of TypeBox-JSON schemas; `subjectPrefix` defaults to the
 * package.json "name" without scope or "ignex"), then writes the artifact
 * atomically (tmp file + rename).
 *
 * @param root - Absolute project root (holds `src/realtime.ts`).
 * @param outDir - Absolute compiler output directory (`<root>/.ignex` by default).
 * @returns Whether an artifact was emitted (false when the app has no
 * `src/realtime.ts`).
 * @throws When `src/realtime.ts` exists but its `realtime` export is missing
 * or malformed.
 */
export const emitRealtimeArtifact = async (root: string, outDir: string): Promise<boolean> => {
  const sourcePath = join(root, "src", "realtime.ts");
  if (!existsSync(sourcePath)) return false;

  let declaration: unknown;
  try {
    // Bun imports TS directly; the unique query keeps repeat loads in one
    // process honest (same trick as ignex.config.ts loading).
    importSeq += 1;
    const url = `${pathToFileURL(sourcePath).href}?t=${Date.now()}-${importSeq}`;
    const mod = (await import(url)) as { realtime?: unknown };
    declaration = mod.realtime;
  } catch (error) {
    throw new Error(
      `Failed to load ${sourcePath}: ${errorMessage(error)} — fix the module or remove it.`,
    );
  }

  if (!isRecord(declaration)) {
    throw new Error(
      `${sourcePath} must export a \`realtime\` object ({ subjectPrefix?, schemas?, events, controlEvents? }).`,
    );
  }
  const events = declaration.events;
  if (!isRecord(events) || Object.keys(events).length === 0) {
    throw new Error(
      `${sourcePath}: \`realtime.events\` must be a non-empty record of event name → TypeBox schema.`,
    );
  }

  const subjectPrefix =
    typeof declaration.subjectPrefix === "string" && declaration.subjectPrefix !== ""
      ? declaration.subjectPrefix
      : await defaultSubjectPrefix(root);

  const artifact: RealtimeArtifact = {
    subjectPrefix,
    events,
  };
  if (declaration.schemas !== undefined) {
    if (!isRecord(declaration.schemas)) {
      throw new Error(`${sourcePath}: \`realtime.schemas\` must be a record of TypeBox schemas.`);
    }
    artifact.schemas = declaration.schemas;
  }
  if (declaration.controlEvents !== undefined) {
    if (!isRecord(declaration.controlEvents)) {
      throw new Error(
        `${sourcePath}: \`realtime.controlEvents\` must be a record of TypeBox schemas.`,
      );
    }
    artifact.controlEvents = declaration.controlEvents;
  }

  await mkdir(outDir, { recursive: true });
  const target = join(outDir, "realtime.json");
  const tmp = join(outDir, ".realtime.json.tmp");
  await writeFile(tmp, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  await rename(tmp, target);
  return true;
};

/**
 * Regenerate the LOCAL realtime SDK (`<outDir>/sdk`) from `realtime.json`.
 *
 * The compiled server imports the generated wire stack (bindings + typed
 * facade), so `ignex build` regenerates it — otherwise a build that runs
 * before `ignex sdk` embeds a STALE wire stack and frames decode silently
 * wrong (observed: string fields coming back empty). Uses the realtime-only
 * writer, so it works BEFORE the first build (no manifest.json required).
 *
 * @returns Whether the SDK was regenerated.
 * @throws When realtime codegen fails (missing `@ignex/nova` or `flatc`).
 */
export const ensureLocalRealtimeSdk = async (_root: string, outDir: string): Promise<boolean> => {
  if (!existsSync(join(outDir, "realtime.json"))) return false;
  const { writeRealtimeSdk } = await import("@ignex/compiler");
  const result = await writeRealtimeSdk({ outDir });
  return result.packages.length > 0;
};
