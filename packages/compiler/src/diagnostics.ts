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

/**
 * A single structured compiler diagnostic: stable code, severity, message,
 * and optional source position/code frame.
 */
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
  ParseError: "IGN_PARSE_ERROR",
  /** A filesystem read during discovery failed. */
  IoReadFailed: "IGN_IO_READ_FAILED",
  /** A directory scan during discovery failed. */
  IoScanFailed: "IGN_IO_SCAN_FAILED",
  /** A module could not be dynamically imported for precompilation. */
  ModuleLoadFailed: "IGN_MODULE_LOAD_FAILED",
  /** Two routes resolve to the same method + path. */
  RouteConflict: "IGN_ROUTE_CONFLICT",
  /** A dynamic route pattern is ambiguous at runtime. */
  AmbiguousRoute: "IGN_AMBIGUOUS_ROUTE",
  /** A route was detected as dead and excluded from the build. */
  DeadRoute: "IGN_ROUTE_DEAD",
  /** A schema failed Ajv standalone compilation; validation was dropped. */
  ValidatorCompileFailed: "IGN_VALIDATOR_COMPILE_FAILED",
  /** Response schema serialization fell back to JSON.stringify. */
  SerializerFallback: "IGN_SERIALIZER_FALLBACK",
  /** A Standard-Schema part has no build-time codegen and is validated/serialized at runtime. */
  StandardSchemaRuntime: "IGN_STANDARD_SCHEMA_RUNTIME",
  /** A route `config` export could not be evaluated at build time. */
  ConfigEvalFailed: "IGN_CONFIG_EVAL_FAILED",
  /** A route references a hook module that does not exist or has no default export. */
  HookMissing: "IGN_HOOK_MISSING",
  /** Writing a generated artifact failed. */
  ArtifactWriteFailed: "IGN_ARTIFACT_WRITE_FAILED",
  /** A compiler option is deprecated and no longer affects output. */
  OptionDeprecated: "IGN_OPTION_DEPRECATED",
  /** An unknown compiler option was passed and ignored. */
  OptionUnknown: "IGN_OPTION_UNKNOWN",
  /** The sync compile path cannot honor async-only features. */
  SyncLimited: "IGN_SYNC_LIMITED",
  /** The linker (Bun.build) failed to produce an output file. */
  LinkFailed: "IGN_LINK_FAILED",
  /** The build cache was unusable and was invalidated. */
  BuildCacheInvalid: "IGN_BUILD_CACHE_INVALID",
} as const;

/** A stable diagnostic code (any value of {@link DiagnosticCodes}). */
export type DiagnosticCode = (typeof DiagnosticCodes)[keyof typeof DiagnosticCodes];

/** The fields accepted when creating a diagnostic. */
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
