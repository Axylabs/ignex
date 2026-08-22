/**
 * @fileoverview Source frontend: source manager.
 *
 * Owns every file the compiler reads (route modules, app config, hooks) for a
 * single build. Each file is read from disk and parsed exactly once; the
 * resulting {@link SourceFile} (with retained AST) is cached by its relative
 * path and handed to every later phase — eliminating the scattered
 * re-reads/re-parses the old pipeline did (discovery, route-graph, app-config,
 * hooks, codegen decisions all re-read or re-parsed `content`).
 *
 * IO is isolated here; phases consume {@link SourceFile} handles only.
 */

import { readFileSync } from "node:fs";
import { DiagnosticCodes, type DiagnosticCollector, errorMessage } from "../diagnostics";
import { clearParseCache, type ParseResult, parseModule } from "../utils/ast";
import { hashString } from "../utils/hash";
import type { SourceFile } from "./source-file";

export class SourceManager {
  private readonly sources = new Map<string, SourceFile>();
  /** Persisted parse results keyed by content hash (loaded once from disk). */
  private readonly diskCache: ReadonlyMap<string, ParseResult>;

  constructor(diskCache?: ReadonlyMap<string, ParseResult>) {
    this.diskCache = diskCache ?? new Map();
  }

  /**
   * Read a file from disk and parse it once, returning the retained
   * `SourceFile`. Returns `null` when the file is missing/unreadable (a
   * `IoReadFailed` diagnostic is emitted) or empty (callers skip silently).
   * Idempotent per relative path.
   */
  read(absPath: string, relPath: string, diagnostics?: DiagnosticCollector): SourceFile | null {
    const existing = this.sources.get(relPath);
    if (existing) return existing;

    let content: string;
    try {
      content = readFileSync(absPath, "utf-8");
    } catch (error) {
      diagnostics?.warn({
        code: DiagnosticCodes.IoReadFailed,
        message: `Failed to read route file: ${errorMessage(error)}`,
        file: absPath,
      });
      return null;
    }

    if (!content || content.length === 0) return null;

    return this.fromSource(absPath, relPath, content, diagnostics);
  }

  /**
   * Build a {@link SourceFile} from already-read source and register it under
   * `relPath`. Idempotent per path: the first call parses (the module-level
   * content-keyed parse cache makes repeated parses cheap) and retains the
   * result; later calls return the same object. Used for files the frontend
   * reads outside the route scan (app config, hooks).
   */
  fromSource(
    absPath: string,
    relPath: string,
    content: string,
    diagnostics?: DiagnosticCollector,
  ): SourceFile {
    const existing = this.sources.get(relPath);
    if (existing) return existing;

    // Rehydrate from the persistent parse cache when the content hash matches,
    // so unchanged modules skip re-parsing on incremental builds. A content
    // change misses the cache and parses from source as usual.
    const diskParsed = this.diskCache.get(hashString(content));
    const parsed = diskParsed ?? parseModule(content, diagnostics);
    const file: SourceFile = {
      path: absPath,
      relPath,
      content,
      parse: parsed,
      ast: parsed.ast,
      imports: parsed.imports,
      exports: parsed.exports,
      symbols: parsed.symbols,
      hasDefaultExport: parsed.hasDefaultExport,
      hasHandlerExport: parsed.hasHandlerExport,
      schemaExport: parsed.schemaExport,
      configExport: parsed.configExport,
      wrappedHandler: parsed.wrappedHandler,
      localHooks: parsed.localHooks,
      handler: parsed.handler,

      ...(parsed.handlerExportName !== undefined
        ? { handlerExportName: parsed.handlerExportName }
        : {}),
      ...(parsed.config !== undefined ? { config: parsed.config } : {}),
      ...(parsed.guards !== undefined ? { guards: parsed.guards } : {}),
    };

    this.sources.set(relPath, file);
    return file;
  }

  /** Look up a previously read source file by relative path. */
  get(relPath: string): SourceFile | undefined {
    return this.sources.get(relPath);
  }

  has(relPath: string): boolean {
    return this.sources.has(relPath);
  }

  /** All source files read so far, in insertion order. */
  all(): SourceFile[] {
    return [...this.sources.values()];
  }

  /**
   * Drop all retained sources and the module-level parse cache. Used by
   * tests / watch restarts to start a clean build.
   */
  clear(): void {
    this.sources.clear();
    clearParseCache();
  }
}
