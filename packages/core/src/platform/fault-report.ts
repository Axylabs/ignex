/**
 * @fileoverview Fault reporting — render a {@link Fault} as one actionable
 * block, and print it exactly once per failure.
 *
 * The same renderer serves every phase: a plugin that fails at boot, an
 * exception inside a request handler, a datastore that rejects the credentials.
 * A report always leads with the classification (which subsystem, which code,
 * how bad, is retrying worth it) and with the configuration to check, then lists
 * what to fix — because a failure the operator cannot act on is just noise.
 *
 * Printing is the ONE side effect, it is idempotent per failure, and it can
 * never itself take down the process: a renderer bug degrades to a single line
 * plus the original throw.
 */

import type { EnvIssue } from "./env-diagnostics";
import type { EnvFileReport } from "./env-report";
import { type ToFaultOptions, toFault } from "./fault";
import type { Fault, FaultRequestInfo } from "./fault-vocabulary";

/** How the block is framed (title + which extra sections to render). */
export interface FaultRenderOptions {
  /** First line, e.g. `ignex boot failed — plugin "db" could not start`. */
  readonly title?: string | undefined;
  /** Dotenv state — renders the "Configuration check (do this first)" section. */
  readonly env?: EnvFileReport | undefined;
  /** Request facts, when the failure happened while serving a request. */
  readonly request?: FaultRequestInfo | undefined;
  /**
   * The line in the operator's OWN code that reached the failure, when the
   * tracing layer can supply it — printed above `where`, which is the frame that
   * actually raised the error (a driver, usually).
   */
  readonly inYourCode?: string | undefined;
}

/**
 * Resolve the request-scoped location in the operator's own code for the failure
 * being reported.
 *
 * The error system cannot know it: `where` comes from the thrown value's stack,
 * and when a dependency raises across an `await` the application frame is not in
 * that stack at all (Bun truncates async stacks at `processTicksAndRejections`).
 * The tracing layer does know it — the failing span recorded the caller chain
 * where it started — so it installs a resolver here. Without one, the report
 * omits the line and looks exactly as before.
 */
export type RequestFrameResolver = (context: unknown) => string | undefined;

/** Process-wide business-frame resolver (installed by the debug layer). */
let requestFrameResolver: RequestFrameResolver | null = null;

/**
 * Install (or clear) the business-frame resolver.
 *
 * @param resolve - The resolver, or `null` to clear it.
 */
export const setRequestFrameResolver = (resolve: RequestFrameResolver | null): void => {
  requestFrameResolver = resolve;
};

/**
 * The business location for `context`, or `undefined` when nothing can supply
 * one. A resolver that throws degrades to `undefined` — reporting must never
 * become the failure.
 *
 * @param context - The request context (may be `undefined` outside a request).
 * @returns `file:line:column` in the operator's own code, when known.
 */
export const requestInYourCode = (context: unknown): string | undefined => {
  if (requestFrameResolver === null || context === undefined) return undefined;
  try {
    return requestFrameResolver(context);
  } catch {
    return undefined;
  }
};

/** A report is only as useful as its first line. */
const DEFAULT_TITLE = "ignex error";

/** Pad a key so the report's value column lines up. */
const padKey = (key: string): string => (key.length >= 9 ? `${key} ` : key.padEnd(9));

/** `5xa-1 · POST /api/gigs → /api/gigs/:id · ip 10.0.0.4`. */
const requestLine = (request: FaultRequestInfo): string | undefined => {
  const head = [
    request.method,
    request.path,
    request.route !== undefined && request.route !== request.path
      ? `→ ${request.route}`
      : undefined,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
  const parts = [
    request.requestId,
    head.length > 0 ? head : undefined,
    request.ip === undefined ? undefined : `ip ${request.ip}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(" · ");
};

/** The `origin · service` tail of the code line. */
const originLabel = (fault: Fault): string =>
  fault.service === undefined ? fault.origin : `${fault.origin} · ${fault.service}`;

/** `Configuration check (do this first)` — dotenv files, connection vars, issues. */
const envSection = (env: EnvFileReport, issues: readonly EnvIssue[]): readonly string[] => {
  const lines: string[] = ["  Configuration check (do this first)"];
  if (env.present.length === 0) {
    lines.push(`    ${padKey(env.candidates[0] ?? ".env")}NOT FOUND in ${env.cwd}`);
  } else {
    for (const file of env.present) lines.push(`    ${padKey(file)}found in ${env.cwd}`);
  }
  for (const example of env.examples) lines.push(`    ${padKey(example)}available to copy from`);
  for (const variable of env.variables) {
    lines.push(`    ${padKey(variable.key)}${variable.display}`);
  }
  for (const issue of issues) lines.push(`    ${padKey(issue.key)}${issue.message}`);
  return lines;
};

/**
 * Render a fault as the multi-line block every ignex failure prints.
 *
 * Sections appear only when they carry information: `where`/`request`/`detail`
 * are omitted when unknown, and the env block only when the caller supplies the
 * dotenv state (boot reports do; request reports read no files).
 *
 * @param fault - The classified failure.
 * @param options - Title, env state, request facts and the business location.
 * @returns The printable block.
 */
export const renderFault = (fault: Fault, options: FaultRenderOptions = {}): string => {
  const lines: string[] = [`✖ ${options.title ?? DEFAULT_TITLE}`, ""];
  lines.push(`  ${padKey("code")}${fault.code} · ${originLabel(fault)}`);
  lines.push(`  ${padKey("what")}${fault.summary}`);
  if (fault.message.length > 0) lines.push(`  ${padKey("message")}${fault.message}`);
  // The business line leads: `where` is the frame that RAISED the error, which
  // is a dependency's file for anything that crossed an await.
  if (options.inYourCode !== undefined) lines.push(`  ${padKey("in code")}${options.inYourCode}`);
  if (fault.detail !== undefined) lines.push(`  ${padKey("detail")}${fault.detail}`);
  if (fault.where !== undefined) lines.push(`  ${padKey("where")}${fault.where}`);
  const request = options.request === undefined ? undefined : requestLine(options.request);
  if (request !== undefined) lines.push(`  ${padKey("request")}${request}`);
  lines.push(
    `  ${padKey("retry")}${
      fault.retryable ? "yes — the same request may succeed later" : "no — fix the cause first"
    }`,
  );

  if (options.env !== undefined) {
    lines.push("");
    lines.push(...envSection(options.env, fault.issues));
  }

  lines.push("");
  lines.push("  What to fix");
  for (const hint of fault.hints) lines.push(`    • ${hint}`);
  if (fault.causes.length > 0) {
    lines.push("");
    lines.push("  Cause chain (innermost last)");
    for (const cause of fault.causes) {
      lines.push(
        `    ${cause.name}: ${cause.message}${cause.code === undefined ? "" : ` (code ${cause.code})`}`,
      );
    }
  }
  lines.push("");
  lines.push("  Full error and stack: IGNEX_DEBUG=1");
  return lines.join("\n");
};

/** Non-enumerable marker: this failure's report has already been printed. */
const REPORTED = Symbol.for("ignex.faultReported");
/** Non-enumerable payload: the structured fault, for programmatic consumers. */
const FAULT = Symbol.for("ignex.fault");

/** Distinct `code|message` pairs tracked for suppression (bounded). */
const DEDUPE_MAX = 64;

/** Suppression state per distinct fault: when it last printed + how many were
 * suppressed since. */
const seen = new Map<string, { at: number; suppressed: number }>();

/**
 * How long an identical fault is suppressed after printing, in milliseconds.
 *
 * On in production (5s) where a failing request under load would otherwise
 * print one block per request; OFF elsewhere, because a developer wants every
 * failure. Override with `IGNEX_ERROR_DEDUPE_MS` (0 disables it).
 */
const dedupeWindow = (): number => {
  const configured = process.env.IGNEX_ERROR_DEDUPE_MS;
  if (configured !== undefined) {
    const parsed = Number.parseInt(configured, 10);
    return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
  }
  return process.env.NODE_ENV === "production" ? 5_000 : 0;
};

/**
 * Forget the suppression state.
 *
 * For tests, and for a long-lived worker that wants a fresh window after a
 * deliberate restart of its work loop.
 */
export const resetFaultDedupe = (): void => {
  seen.clear();
};

/**
 * Decide whether this fault should print now, and how many identical reports
 * were suppressed since the last one.
 *
 * @param fault - The classified failure.
 * @returns `suppressed: true` to stay quiet; `since` is the count to mention.
 */
const shouldPrint = (fault: Fault): { suppressed: boolean; since: number } => {
  const window = dedupeWindow();
  if (window === 0) return { suppressed: false, since: 0 };

  const key = `${fault.code}|${fault.message}`;
  const now = Date.now();
  const entry = seen.get(key);
  if (entry !== undefined && now - entry.at < window) {
    entry.suppressed += 1;
    return { suppressed: true, since: entry.suppressed };
  }

  const since = entry?.suppressed ?? 0;
  // Re-inserting refreshes insertion order; the oldest key is evicted first.
  seen.delete(key);
  seen.set(key, { at: now, suppressed: 0 });
  if (seen.size > DEDUPE_MAX) {
    const oldest = seen.keys().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return { suppressed: false, since };
};

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

const markReported = (thrown: unknown): void => {
  if (!isRecord(thrown)) return;
  try {
    Object.defineProperty(thrown, REPORTED, { value: true, enumerable: false });
  } catch {
    // A frozen error object is fine — the marker is an optimization only.
  }
};

/** True when {@link reportFault} already printed a report for this value. */
export const isFaultReported = (thrown: unknown): boolean =>
  isRecord(thrown) && (thrown as Record<PropertyKey, unknown>)[REPORTED] === true;

/** The structured fault behind an error returned by {@link reportFault}. */
export const faultOf = (reported: unknown): Fault | undefined => {
  if (!isRecord(reported)) return undefined;
  const fault = (reported as Record<PropertyKey, unknown>)[FAULT];
  return fault === undefined ? undefined : (fault as Fault);
};

/** Options for {@link reportFault}. */
export interface ReportFaultOptions extends FaultRenderOptions, ToFaultOptions {
  /** A fault computed by the caller (skips classification). */
  readonly fault?: Fault | undefined;
  /** Prefix for the compact error returned to the caller. */
  readonly label?: string | undefined;
}

/**
 * Report a failure and return the compact error a caller should throw.
 *
 * Prints the block to stderr exactly once per failure (`IGNEX_DEBUG=1` also
 * prints the original object, with its stack and properties, for debugging) and
 * returns a small `Error` whose message is `"<label>: <message>"` — the raw
 * driver object is deliberately NOT attached as `cause`, since Bun's
 * uncaught-error printer expands a driver's enumerable object graph into
 * hundreds of lines of noise.
 *
 * The returned error carries the {@link Fault} as a non-enumerable property
 * ({@link faultOf}) so the boundary can answer with the classified status/code.
 *
 * In production, identical faults (`code` + message) are printed once per 5s
 * window with a suppression count — a failing request under load cannot flood
 * the log. Development prints every failure (`IGNEX_ERROR_DEDUPE_MS` overrides,
 * `0` disables).
 *
 * @param thrown - Whatever was thrown.
 * @param options - Title/label, request facts, env state, or a pre-built fault.
 * @returns The compact error, carrying the fault.
 */
export const reportFault = (thrown: unknown, options: ReportFaultOptions = {}): Error => {
  const fault = options.fault ?? toFault(thrown, options);
  const label = options.label ?? "[ignex] request failed";
  const compact = new Error(
    `${label}: ${fault.message.length > 0 ? fault.message : fault.summary}`,
  );
  Object.defineProperty(compact, FAULT, { value: fault, enumerable: false });

  if (isFaultReported(thrown)) return compact;

  const decision = shouldPrint(fault);
  if (decision.suppressed) {
    markReported(thrown);
    markReported(compact);
    return compact;
  }

  try {
    const block = renderFault(fault, options);
    console.error(
      decision.since === 0
        ? block
        : `${block}\n  (${decision.since} identical report(s) suppressed in the last ${
            dedupeWindow() / 1000
          }s)`,
    );
    if (process.env.IGNEX_DEBUG === "1") console.error(thrown);
  } catch (renderError) {
    // Reporting must never become the failure: degrade to one line + the throw.
    console.error(
      `[ignex] ${label}: ${fault.code} ${fault.summary} (report rendering failed: ${String(renderError)})`,
      thrown,
    );
  }
  markReported(thrown);
  // Also mark the compact error: handing it back to a reporter (the plugin
  // registry and the app factory both report one failure) must not print twice.
  markReported(compact);
  return compact;
};

/**
 * Read the request facts a report can carry off a context-like object.
 *
 * Every field is optional and read defensively: the AOT-compiled server hands
 * its specialized per-route context (which carries only the members the route
 * uses), the interpreted one hands the full context. Unknown members are simply
 * omitted from the report.
 *
 * @param source - A context-like object (or anything else).
 * @returns The request facts, or `undefined` when none are readable.
 */
export const faultRequestInfo = (source: unknown): FaultRequestInfo | undefined => {
  if (!isRecord(source)) return undefined;
  const read = (key: string): string | undefined => {
    const value = source[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  // The middleware-assigned id is the one echoed in `x-request-id`; the
  // context's lazy `requestId` is the fallback (and may be absent on the
  // specialized AOT context).
  let requestId = read("requestId");
  const getState = source.getState;
  if (typeof getState === "function") {
    try {
      const state = (getState as (key: string) => unknown)("requestId");
      if (typeof state === "string" && state.length > 0) requestId = state;
    } catch {
      // A throwing `getState` must never break error reporting.
    }
  }

  const method = read("method");
  const path = read("path");
  const route = read("route");
  const ip = read("ip");
  const info: FaultRequestInfo = {
    ...(method === undefined ? {} : { method }),
    ...(path === undefined ? {} : { path }),
    ...(route === undefined ? {} : { route }),
    ...(ip === undefined ? {} : { ip }),
  };
  return requestId === undefined && Object.keys(info).length === 0
    ? undefined
    : { ...(requestId === undefined ? {} : { requestId }), ...info };
};
