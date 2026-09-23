/**
 * @fileoverview Frames — capturing, classifying and reading back a stack the way
 * a person reads it: which frames are YOUR code, which are the framework, which
 * are a dependency's and which are the compiled artifact.
 *
 * A captured stack is honest but not readable. The interesting frame (the route
 * that called the ORM) routinely sits under a driver's internals, core's
 * lifecycle and two generated dispatch frames — and for an error raised across
 * an `await`, Bun truncates the async stack at `processTicksAndRejections`, so
 * the application frame is not in the error's own stack AT ALL. The trace's
 * spans remember it: each span stores the caller chain captured where it
 * started (`Span.origin`), which is the application call site.
 *
 * So a failure is summarized from two inputs — the error's stack and the failing
 * span's origin — into business logic vs everything else, with the location in
 * the operator's own code first. All of it is pure string work: no I/O, no state.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sharedSourceFrames } from "./sourcemaps";
import type { FrameClass, Span, TraceFrames } from "./types";

/** A synthesized runtime frame (`native:7:39`, `node:internal/…`) — no file. */
const SYNTHETIC = /^(?:native|node):/;
/** A third-party package. */
const DEPENDENCY = /[\\/]node_modules[\\/]/;
/**
 * The framework itself — the packages that make up ignex, installed
 * (`node_modules/@ignex/core`) or linked (`packages/core/src`). A first-party
 * library consumed as a dependency (`@ignex/ninox`, an ORM) is NOT the
 * framework: it is a dependency, and naming it one tells the reader who owns
 * the frame.
 */
const FRAMEWORK =
  /[\\/](?:@ignex[\\/]|packages[\\/])(?:core|shared|native|compiler|cli|mcp|create|test-utils)[\\/]/;
/** Compiler output: the bundle, its entry shim, the `.ignex` build dir. */
const GENERATED = /(?:[\\/]\.ignex[\\/]|[\\/]dist(?:-dev)?[\\/]|__server\.js(?:\.entry\.js)?$)/;
/** `file:line:column` tail of a frame line. */
const FRAME_LOC = /\(?([^()\s]+):(\d+):(\d+)\)?\s*$/;

/** `file:line:column` of a frame line, or `undefined` when it names none. */
export const frameLocation = (line: string): string | undefined => {
  const match = FRAME_LOC.exec(line.trim());
  return match === null ? undefined : `${match[1]}:${match[2]}:${match[3]}`;
};

/**
 * Classify a `file:line:column` location by the file it names.
 *
 * Path SHAPES, not heuristics about who threw: `node_modules` is a dependency,
 * `@ignex/*` and the workspace packages below `packages/<pkg>/` are the
 * framework, the build output is generated, and everything else is the
 * application's own code.
 *
 * @param where - A frame location (`/srv/app/src/routes/x.ts:12:5`).
 * @returns The class.
 */
export const classifyLocation = (where: string): FrameClass => {
  if (SYNTHETIC.test(where)) return "synthetic";
  // Framework before dependency: `node_modules/@ignex/core` is the framework,
  // and naming it that way is what tells the reader who owns the frame.
  if (FRAMEWORK.test(where)) return "framework";
  if (DEPENDENCY.test(where)) return "dependency";
  if (GENERATED.test(where)) return "generated";
  return "app";
};

/**
 * Classify one stack-frame line.
 *
 * @param line - A frame line (`    at handler (/srv/app/src/routes/x.ts:12:5)`).
 * @returns The class, or `"none"` for a line that is not a frame.
 */
export const classifyFrame = (line: string): FrameClass => {
  const where = frameLocation(line);
  return where === undefined ? "none" : classifyLocation(where);
};

/** The frames a failure should be told with: your code, then everything else. */
export interface FailureFramesInput {
  /** The error's own (source-mapped) stack, when it has one. */
  readonly stack?: string | null | undefined;
  /** Caller chains captured by the trace's spans, most relevant first. */
  readonly origins?: readonly (string | null | undefined)[] | undefined;
}

/** Frame lines that name no location (stack headers, `at async` tails). */
const frameLines = (block: string | null | undefined): string[] =>
  block === null || block === undefined
    ? []
    : block
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("at ") && frameLocation(line) !== undefined);

/**
 * Summarize a failure into `{ app, internal, appWhere }` — business logic
 * first, the machinery after, and never a synthetic frame.
 *
 * `appWhere` prefers the error's own stack (the exact line that threw) and falls
 * back to the failing span's origin (the application call site that started the
 * work) — which is the only application frame that exists when a dependency
 * raised the error across an `await`.
 *
 * @param input - The error stack and the relevant span origins (see
 *   {@link FailureFramesInput}).
 * @returns The frames, or `null` when nothing usable was captured.
 */
export const summarizeFailureFrames = (input: FailureFramesInput): TraceFrames | null => {
  const stack = frameLines(input.stack);
  const origins = (input.origins ?? []).flatMap(frameLines);
  const app: string[] = [];
  const internal: string[] = [];
  const seenApp = new Set<string>();
  const seenInternal = new Set<string>();
  let appWhere: string | undefined;

  // The error's OWN stack leads: when application code threw synchronously, its
  // top application frame is the exact throw site.
  for (const line of [...stack, ...origins]) {
    if (classifyFrame(line) !== "app") continue;
    if (seenApp.has(line)) continue;
    seenApp.add(line);
    app.push(line);
    appWhere ??= frameLocation(line);
  }
  // Everything else is the machinery that carried the failure — kept in capture
  // order (the error's frames first, then the caller chain from the span).
  // Synthetic frames (`native:7:39`) explain nothing and are dropped.
  for (const line of [...stack, ...origins]) {
    const kind = classifyFrame(line);
    if (kind === "app" || kind === "synthetic" || kind === "none" || seenInternal.has(line)) {
      continue;
    }
    seenInternal.add(line);
    internal.push(line);
  }
  if (app.length === 0 && internal.length === 0) return null;
  return { app, internal, ...(appWhere === undefined ? {} : { appWhere }) };
};

/**
 * The caller chains that locate a failure in the operator's own code: the span
 * that failed, then its ANCESTORS.
 *
 * The deepest span is not enough. When a dependency raises across an `await`,
 * the failing span's own chain is truncated at `processTicksAndRejections`
 * (nothing but a synthetic frame), while the span that STARTED that work — the
 * application's own wrapper — still records the route line that called it.
 * Walking outwards is what turns "Command aggregate requires authentication"
 * into "your code reached this at src/routes/api/gigs/index.get.ts:7:27".
 *
 * @param spans - The trace's spans (any order).
 * @param faultSpanId - The failing span's id, or `null`.
 * @returns The origins to feed {@link summarizeFailureFrames} (possibly empty).
 */
export const failingOrigin = (
  spans: readonly Span[],
  faultSpanId: number | null,
): (string | null)[] => {
  if (faultSpanId === null) return [null];
  const byId = new Map(spans.map((span) => [span.id, span]));
  const origins: string[] = [];
  const seen = new Set<number>();
  let current = byId.get(faultSpanId);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.origin !== null) origins.push(current.origin);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return origins.length === 0 ? [null] : origins;
};

/* ── capture (what the tracer records in the first place) ──────────────── */

/**
 * Directory of the debug layer as seen at runtime. NOTE: inside a compiled
 * bundle `import.meta.url` is the bundle file (`.ignex/server.js`), so this
 * does NOT match sourcemapped frames — they resolve back to core's real
 * source tree. {@link isInternalFrame} therefore also matches stable path shapes
 * (packages/core/src/debug, @ignex/core) that hold wherever core is
 * installed (workspace link, node_modules, published tarball).
 */
const DEBUG_SRC_DIR = dirname(fileURLToPath(import.meta.url));

/** True when a (remapped) frame belongs to framework/vendor internals. */
export const isInternalFrame = (frame: string): boolean =>
  frame.includes(`${DEBUG_SRC_DIR}/`) ||
  frame.includes("packages/core/src/debug/") ||
  /[\\/]@ignex[\\/]core[\\/]/.test(frame) ||
  /\bnode_modules\b/.test(frame) ||
  /\bat\s+(?:async\s+)?(?:node|native):/.test(frame);

/**
 * Capture an error stack for the trace: sourcemapped where maps are
 * registered, keeping the FULL chain in true order (capped at `cap` frames so
 * a pathological recursion cannot balloon the ring). The complete chain —
 * framework and vendor frames included — is what lets a developer trace where
 * an error actually started.
 *
 * @param stack - The raw `Error.stack`, when the throw had one.
 * @param cap - Maximum frames kept.
 * @returns The remapped stack, or `null` when there is nothing to keep.
 */
export const captureErrorStack = (stack: string | undefined, cap = 40): string | null => {
  if (!stack) return null;
  const remap = sharedSourceFrames().remapFrame;
  const lines = stack.split("\n").filter((l) => l.trim().length > 0);
  const header = lines[0] && !lines[0].trimStart().startsWith("at ") ? (lines[0] as string) : null;
  const frames = (header ? lines.slice(1) : lines).map(remap).slice(0, cap);
  if (frames.length === 0) return null;
  return (header ? [header, ...frames] : frames).join("\n");
};

/**
 * The caller chain of a span — "where was this span created", traced from the
 * APPLICATION call site through every frame below it (capped so a deep chain
 * cannot balloon the trace). The leading debug-layer wrappers (`Trace.start`,
 * `debugQuery`, `ctx.debug.*`) are skipped so the chain STARTS at the app
 * code that created the span; everything beneath it — helper libraries such
 * as ninox, route handlers, framework hooks, node internals — is kept in
 * true order, so an origin can be traced back to the request entry point
 * instead of stopping at the first wrapper frame.
 *
 * @param cap - Maximum frames kept.
 * @returns The caller chain, or `null` when every frame was internal.
 */
export const callerOrigin = (cap = 16): string | null => {
  const lines = new Error().stack?.split("\n") ?? [];
  const remap = sharedSourceFrames().remapFrame;
  const kept: string[] = [];
  let started = false;
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i]?.trim();
    if (!raw || raw === "Error") continue;
    const mapped = remap(raw);
    if (!started) {
      if (isInternalFrame(mapped)) continue;
      started = true;
    }
    kept.push(mapped);
    if (kept.length >= cap) break;
  }
  if (kept.length === 0) return null;
  return kept.join("\n");
};
