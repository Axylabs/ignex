/**
 * @fileoverview Parser bridge — synchronous parser fallback chain.
 *
 * First synchronous parser that succeeds wins: `oxc-parser` → `Bun.parse` →
 * `Bun.parseSync` → `Bun.Transpiler.parse` → `Bun.Transpiler.parseSync`. When
 * every parser fails, the caller (parseModule) degrades to an empty `Program`
 * alongside a parse diagnostic so downstream phases fail safely.
 */

import * as oxcParser from "oxc-parser";
import type { Program } from "../ast-types";

/**
 * Info about the most useful parser failure seen while walking the chain.
 * The FIRST failure recorded is usually the most precise (oxc reports exact
 * positions); later fallbacks only add "also failed" noise.
 */
export interface ParserFailureInfo {
  readonly message: string;
  /** Byte offset into the source when the parser reported one. */
  readonly offset?: number;
}

/** An Error thrown by {@link parseToAst} carrying a source offset when known. */
export interface ParseFailureError extends Error {
  readonly parseOffset?: number;
}

/** Normalize any parser return shape into a usable Program node. */
function normalizeAst(result: unknown): Program {
  if (!result) return { type: "Program", body: [] };

  const withErrors = result as { errors?: Array<{ message?: string }> };
  if (withErrors.errors && withErrors.errors.length > 0) {
    throw new Error(withErrors.errors[0]?.message ?? "AST parse error");
  }

  // The one parser-specific cast in the AST layer: parser return shapes are
  // structurally untyped, so we trust the Program-shaped result at the
  // boundary and use the typed model everywhere downstream.
  const container = result as Record<string, unknown>;
  const ast = (container.program ?? container.ast ?? container.root ?? result) as {
    type?: string;
    body?: unknown;
  };

  if (!ast.type) ast.type = "Program";
  if (!Array.isArray(ast.body)) ast.body = [];

  return ast as unknown as Program;
}

function tryOxcParser(source: string, failures: ParserFailureInfo[]): unknown | undefined {
  const mod = oxcParser as unknown as {
    parseSync?: (arg0: unknown, arg1?: unknown, arg2?: unknown) => unknown;
  };
  const parseSync = mod.parseSync;

  if (typeof parseSync !== "function") return undefined;

  /** Record an oxc error entry (message + offset when numeric fields exist). */
  const recordOxcError = (entry: {
    message?: string;
    start?: unknown;
    span?: { start?: unknown };
    loc?: { start?: unknown };
  }): void => {
    if (failures.length > 0) return; // first failure wins
    let offset: number | undefined;
    for (const candidate of [entry.start, entry.span?.start, entry.loc?.start]) {
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        offset = candidate;
        break;
      }
    }
    failures.push({
      message: typeof entry.message === "string" ? entry.message : "AST parse error",
      ...(offset !== undefined ? { offset } : {}),
    });
  };

  const attempts = [
    () =>
      parseSync("ignex.ts", source, {
        sourceType: "module",
        target: "esnext",
      }),
    () =>
      parseSync(source, {
        sourceType: "module",
        target: "esnext",
      }),
  ];

  for (const attempt of attempts) {
    try {
      const result = attempt() as {
        then?: unknown;
        errors?: Array<{
          message?: string;
          start?: unknown;
          span?: { start?: unknown };
          loc?: { start?: unknown };
        }>;
        program?: unknown;
        ast?: unknown;
      } | null;

      if (result && typeof result.then === "function") continue;
      if (result?.errors?.length) {
        recordOxcError(result.errors[0] ?? {});
        continue;
      }

      const program = result?.program ?? result?.ast ?? result;

      if (program && typeof program === "object") {
        const p = program as { type?: unknown; body?: unknown };
        if (p.type || Array.isArray(p.body)) return program;
      }
    } catch {
      // try next shape
    }
  }

  return undefined;
}

export function parseToAst(source: string): Program {
  // Collect the chain's failures so the thrown error names the REAL cause
  // (e.g. oxc's "Unexpected token" with an offset) instead of a generic
  // "no parser available" message that masks ordinary typos.
  const failures: ParserFailureInfo[] = [];

  const oxc = tryOxcParser(source, failures);
  if (oxc) return normalizeAst(oxc);

  // Access Bun via globalThis so this module also typechecks under
  // non-Bun tsconfigs (e.g. the CLI's `types: ["node"]`). At runtime this is
  // undefined outside Bun, and each access below guards with `typeof`.
  const B: any = (globalThis as any).Bun;

  const parsers: Array<() => unknown> = [
    () =>
      typeof B.parse === "function"
        ? B.parse(source, {
            loader: "ts",
            target: "bun",
            ranges: true,
            loc: true,
          })
        : undefined,

    () =>
      typeof B.parseSync === "function"
        ? B.parseSync(source, {
            loader: "ts",
            target: "bun",
            ranges: true,
            loc: true,
          })
        : undefined,

    () => {
      const transpiler = B.Transpiler
        ? new B.Transpiler({ loader: "ts", target: "bun" })
        : undefined;
      return transpiler && typeof transpiler.parse === "function"
        ? transpiler.parse(source, { ranges: true, loc: true })
        : undefined;
    },

    () => {
      const transpiler = B.Transpiler
        ? new B.Transpiler({ loader: "ts", target: "bun" })
        : undefined;
      return transpiler && typeof transpiler.parseSync === "function"
        ? transpiler.parseSync(source, { ranges: true, loc: true })
        : undefined;
    },
  ];

  for (const parser of parsers) {
    try {
      const result = parser() as { then?: unknown } | undefined;
      if (result && typeof result.then === "function") continue;
      if (result) return normalizeAst(result);
    } catch (error) {
      if (failures.length === 0) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ message: message || "parser failed" });
      }
    }
  }

  // Every parser rejected the source — surface the most informative failure
  // (with its offset, when known) so parse diagnostics can render a real
  // code frame instead of framing line 1.
  if (failures.length > 0 && failures[0]) {
    const { message, offset } = failures[0];
    const error = new Error(message || "Failed to parse module") as ParseFailureError;
    if (offset !== undefined) {
      Object.defineProperty(error, "parseOffset", { value: offset, enumerable: false });
    }
    throw error;
  }

  throw new Error(
    "No synchronous JS/TS AST parser available. Install oxc-parser or use a Bun version with Bun.parse/Bun.parseSync.",
  );
}
