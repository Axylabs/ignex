/**
 * @fileoverview Codegen: the emitted native run block.
 *
 * Split out of `native.ts` (maintainability size cap). Emits the
 * `if (__native) { … }` prelude that packs the frame, runs the pre-baked
 * native stack once, seeds query/cookie state byte-identically to the JS
 * prelude, and throws native body verdicts before any JS parse.
 */

import type { CompilerOptions, RouteIR } from "../../../types";
import { nativeRouteVar } from "../identifiers";
import type { ValidationFlags } from "./validate";

/** Body-size limit embedded in the native plan + the JS fallback read. */
export const maxBodyLiteral = (opts: CompilerOptions): number =>
  opts.maxJsonBytes ?? 2 * 1024 * 1024;

/**
 * The `if (__native) { … }` block: pack the frame (raw body bytes pass through
 * zero-copy), run the pre-baked stack once, seed query/cookie records on
 * success, and — for body-validating routes — throw on a native body verdict
 * (400 = not valid JSON, 422 = failed its schema) BEFORE any JS parse. A
 * failed/thrown native run leaves everything undefined so the JS prelude
 * below remains the parity fallback.
 *
 * Runtime body-schema routes skip body work on GET/HEAD/OPTIONS — exactly
 * matching the `emitBodyPrelude` guard (a precompiled body validator always
 * parses, so its routes get no method guard).
 */
export const emitNativeRunBlock = (
  route: RouteIR,
  opts: CompilerOptions,
  flags: ValidationFlags,
  needsQuery: boolean,
  needsCookie: boolean,
  needsBody: boolean,
  queryValidated: boolean,
): string[] => {
  const out: string[] = [];
  const bodyGuard =
    needsBody && !flags.hasBodyValidator
      ? `req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS"`
      : null;

  out.push(`const __native = ${nativeRouteVar(route)};`);
  out.push(`if (__native) {`);
  out.push(`  const __qIdx = req.url.indexOf("?");`);
  out.push(`  let __nr;`);
  if (needsBody) {
    // Bounded read (content-length pre-check + incremental chunked cap) —
    // NEVER an unconditional `req.arrayBuffer()`: that buffers up to Bun's
    // server cap per in-flight request on routes whose real limit is
    // `maxBodyBytes`. A 413 here propagates exactly like the JS body prelude's
    // size guard (same BodyParseError shape).
    out.push(
      `  const __bodyBytes = ${
        bodyGuard
          ? `${bodyGuard} ? await readBodyBounded(req, ${maxBodyLiteral(opts)}) : new Uint8Array(0)`
          : `await readBodyBounded(req, ${maxBodyLiteral(opts)})`
      };`,
    );
  }
  out.push(`  try {`);
  // runParts(query, cookie, body) — the pre-encoded frame pack + ONE native
  // call, no per-request frame object (synced from castrum's
  // `native-route.ts` `run(query, cookie, body)` shape).
  out.push(
    `    __nr = __native.runParts(__qIdx < 0 ? "" : req.url.slice(__qIdx + 1), req.headers.get("cookie") ?? "", ${needsBody ? "__bodyBytes" : "null"});`,
  );
  out.push(`  } catch {`);
  out.push(`    __nr = null;`);
  out.push(`  }`);
  out.push(`  if (__nr) {`);
  if (needsBody) {
    // First-failure-wins: 400 = not valid JSON, 422 = failed its schema,
    // 413 = oversized body. All throw BEFORE any JS parse — matching the JS
    // prelude's error precedence for the same conditions.
    out.push(`    ${bodyGuard ? `if (${bodyGuard}) {` : "if (true) {"}`);
    out.push(`      if (!__nr.ok) {`);
    out.push(`        if (__nr.errorCode === 400) {`);
    out.push(`          throw new BodyParseError("Invalid JSON body");`);
    out.push(`        }`);
    out.push(`        if (__nr.errorCode === 422) {`);
    out.push(`          throw validationError(__schema?.body ?? {}, "body");`);
    out.push(`        }`);
    out.push(`        if (__nr.errorCode === 413) {`);
    out.push(`          throw new BodyParseError("Payload too large", 413);`);
    out.push(`        }`);
    out.push(`      }`);
    out.push(`    }`);
  }
  out.push(`    if (__nr.ok) {`);
  if (needsQuery) {
    // A schema-validated query becomes the grouped Record the validator
    // consumes; a usage-only query keeps the URLSearchParams contract.
    out.push(
      queryValidated
        ? `      __query = groupQueryPairs(__nr.query);`
        : `      ctx.query = new NativeQueryParams(__nr.query);`,
    );
  }
  if (needsCookie) out.push(`      __cookies = cookiePairsToRecord(__nr.cookie);`);
  if (needsBody) {
    out.push(
      `      ${bodyGuard ? `if (${bodyGuard}) { __bodyValidated = true; }` : "__bodyValidated = true;"}`,
    );
  }
  out.push(`    }`);
  out.push(`  }`);
  out.push(`}`);
  return out;
};
