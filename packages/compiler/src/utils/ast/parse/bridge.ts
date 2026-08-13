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

function tryOxcParser(source: string): unknown | undefined {
  const mod = oxcParser as unknown as {
    parseSync?: (arg0: unknown, arg1?: unknown, arg2?: unknown) => unknown;
  };
  const parseSync = mod.parseSync;

  if (typeof parseSync !== "function") return undefined;

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
        errors?: Array<{ message?: string }>;
        program?: unknown;
        ast?: unknown;
      } | null;

      if (result && typeof result.then === "function") continue;
      if (result?.errors?.length) continue;

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
  const oxc = tryOxcParser(source);
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
    } catch {
      // try next parser
    }
  }

  throw new Error(
    "No synchronous JS/TS AST parser available. Install oxc-parser or use a Bun version with Bun.parse/Bun.parseSync.",
  );
}
