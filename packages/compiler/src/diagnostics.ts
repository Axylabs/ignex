/**
 * @fileoverview Compiler diagnostics — Svelte-style warnings/errors.
 *
 * The compiler collects structured diagnostics (code + severity + message +
 * optional file position + code frame) across all phases instead of relying
 * solely on ad-hoc `console.log` calls. This gives the CLI, IDEs, and CI
 * pipelines a stable, machine-readable contract for surfacing problems.
 *
 * Design notes:
 * - Every diagnostic carries a stable `code` (see {@link DiagnosticCodes}).
 * - Positions are 1-based lines / 0-based columns (ESTree convention).
 * - A diagnostic may reference a source file and include a rendered code
 *   frame so messages are actionable in a terminal.
 */

export type DiagnosticSeverity = "error" | "warning" | "info";

/** 1-based line, 0-based column (ESTree `loc` convention). */
export interface DiagnosticPosition {
  readonly line: number;
  readonly column: number;
}

export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  /** Absolute or workspace-relative path the diagnostic refers to. */
  readonly file?: string;
  readonly position?: DiagnosticPosition;
  /** Rendered source excerpt with a caret marker. */
  readonly frame?: string;
  readonly related?: readonly Diagnostic[];
}

/**
 * Stable diagnostic codes. Treat these as a public contract — rename or reuse
 * them only as a deliberate, documented breaking change.
 */
export const DiagnosticCodes = {
  /** A route/hook/app-config module failed to parse. */
  ParseError: "FLX_PARSE_ERROR",
  /** A filesystem read during discovery failed. */
  IoReadFailed: "FLX_IO_READ_FAILED",
  /** A directory scan during discovery failed. */
  IoScanFailed: "FLX_IO_SCAN_FAILED",
  /** A module could not be dynamically imported for precompilation. */
  ModuleLoadFailed: "FLX_MODULE_LOAD_FAILED",
  /** Two routes resolve to the same method + path. */
  RouteConflict: "FLX_ROUTE_CONFLICT",
  /** A dynamic route pattern is ambiguous at runtime. */
  AmbiguousRoute: "FLX_AMBIGUOUS_ROUTE",
  /** A route was detected as dead and excluded from the build. */
  DeadRoute: "FLX_ROUTE_DEAD",
  /** A schema failed Ajv standalone compilation; validation was dropped. */
  ValidatorCompileFailed: "FLX_VALIDATOR_COMPILE_FAILED",
  /** Response schema serialization fell back to JSON.stringify. */
  SerializerFallback: "FLX_SERIALIZER_FALLBACK",
  /** A route `config` export could not be evaluated at build time. */
  ConfigEvalFailed: "FLX_CONFIG_EVAL_FAILED",
  /** A route references a hook module that does not exist or has no default export. */
  HookMissing: "FLX_HOOK_MISSING",
  /** Writing a generated artifact failed. */
  ArtifactWriteFailed: "FLX_ARTIFACT_WRITE_FAILED",
  /** A compiler option is deprecated and no longer affects output. */
  OptionDeprecated: "FLX_OPTION_DEPRECATED",
  /** An unknown compiler option was passed and ignored. */
  OptionUnknown: "FLX_OPTION_UNKNOWN",
  /** The sync compile path cannot honor async-only features. */
  SyncLimited: "FLX_SYNC_LIMITED",
  /** The linker (Bun.build) failed to produce an output file. */
  LinkFailed: "FLX_LINK_FAILED",
  /** The build cache was unusable and was invalidated. */
  BuildCacheInvalid: "FLX_BUILD_CACHE_INVALID",
} as const;

export type DiagnosticCode = (typeof DiagnosticCodes)[keyof typeof DiagnosticCodes];

export interface DiagnosticInit {
  readonly code: DiagnosticCode | string;
  readonly message: string;
  readonly file?: string | undefined;
  readonly position?: DiagnosticPosition | undefined;
  readonly frame?: string | undefined;
  readonly related?: readonly Diagnostic[] | undefined;
}

/**
 * Render a Svelte-style code frame: two lines of surrounding context plus a
 * caret pointing at the offending column.
 */
export const getCodeFrame = (
  source: string,
  position: DiagnosticPosition,
  contextLines = 1,
): string | undefined => {
  if (!source || !position || position.line < 1) return undefined;

  const lines = source.split("\n");
  const target = position.line - 1;

  if (target >= lines.length) return undefined;

  const start = Math.max(0, target - contextLines);
  const end = Math.min(lines.length - 1, target + contextLines);
  const gutterWidth = String(end + 1).length;
  const out: string[] = [];

  for (let i = start; i <= end; i++) {
    const marker = i === target ? ">" : " ";
    const lineNo = String(i + 1).padStart(gutterWidth);
    out.push(`${marker} ${lineNo} | ${lines[i]}`);

    if (i === target) {
      const pad = " ".repeat(Math.max(0, position.column));
      out.push(`  ${" ".repeat(gutterWidth)} | ${pad}^`);
    }
  }

  return out.join("\n");
};

/** Extract a human-readable message from an unknown thrown value. */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Central, phase-agnostic diagnostic collector.
 *
 * Each phase receives the collector and reports recoverable problems as
 * warnings and fatal problems as errors. The orchestrator owns one collector
 * per compile and surfaces the result to callers.
 */
export class DiagnosticCollector {
  private readonly items: Diagnostic[] = [];

  add(d: DiagnosticInit & { severity: DiagnosticSeverity }): void {
    this.items.push({
      code: d.code,
      severity: d.severity,
      message: d.message,
      ...(d.file !== undefined ? { file: d.file } : {}),
      ...(d.position !== undefined ? { position: d.position } : {}),
      ...(d.frame !== undefined ? { frame: d.frame } : {}),
      ...(d.related !== undefined && d.related.length > 0 ? { related: d.related } : {}),
    });
  }

  error(init: DiagnosticInit): void {
    this.add({ ...init, severity: "error" });
  }

  warn(init: DiagnosticInit): void {
    this.add({ ...init, severity: "warning" });
  }

  info(init: DiagnosticInit): void {
    this.add({ ...init, severity: "info" });
  }

  get all(): readonly Diagnostic[] {
    return this.items;
  }

  get warnings(): readonly Diagnostic[] {
    return this.items.filter((d) => d.severity === "warning");
  }

  get errors(): readonly Diagnostic[] {
    return this.items.filter((d) => d.severity === "error");
  }

  get infos(): readonly Diagnostic[] {
    return this.items.filter((d) => d.severity === "info");
  }

  get hasErrors(): boolean {
    return this.errors.length > 0;
  }

  get count(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
  }
}

/** Format a single diagnostic as a human-readable, terminal-friendly line. */
export const formatDiagnostic = (d: Diagnostic): string => {
  const location = d.file
    ? d.position
      ? `${d.file}:${d.position.line}:${d.position.column}`
      : d.file
    : "";

  const head = `${d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "info"}${location ? ` (${location})` : ""}: ${d.message} [${d.code}]`;

  return d.frame ? `${head}\n${d.frame}` : head;
};

/** Render a diagnostic collection to a Logger sink. */
export const reportDiagnostics = (
  diagnostics: readonly Diagnostic[],
  logger: { warn(msg: string): void; error(msg: string): void; info(msg: string): void },
): void => {
  for (const d of diagnostics) {
    const text = formatDiagnostic(d);
    if (d.severity === "error") logger.error(text);
    else if (d.severity === "warning") logger.warn(text);
    else logger.info(text);
  }
};
