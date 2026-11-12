/**
 * @fileoverview Codegen: the emitted native run block.
 *
 * Split out of `native.ts` (maintainability size cap). Emits the
 * `if (__native) { … }` prelude that runs the pre-baked native stack once,
 * seeds query/cookie state byte-identically to the JS
 * prelude, and throws native body verdicts before any JS parse.
 */

import type { CompilerOptions, RouteIR } from "../../../types";
import { nativeRouteVar } from "../identifiers";
import type { ValidationFlags } from "./validate";

/** Body-size limit embedded in the native plan + the JS fallback read. */
export const maxBodyLiteral = (opts: CompilerOptions): number =>
  opts.maxJsonBytes ?? 2 * 1024 * 1024;

/**
 * The `if (__native) { … }` block: run the pre-baked stack directly from
 * request components, seed query/cookie records on
 * success, and — for body-validating routes — throw on a native body verdict
 * (400 = not valid JSON, 422 = failed its schema) BEFORE any JS parse. A
 * failed/thrown native run leaves everything undefined so the JS prelude
 * below remains the parity fallback.
 *
 * Runtime body-schema routes skip body work on GET/HEAD/OPTIONS — exactly
 * matching the `emitBodyPrelude` guard (a precompiled body validator always
 * parses, so its routes get no method guard).
 *
 * `adaptive` (compiler option `nativeRoutesAdaptive`) swaps the always-native
 * gate for the learned selector: the request components become locals, the
 * body read STAYS BEFORE `chooseExecution` (body I/O must not pollute the
 * measured span — both modes are measured over parse+validate only), and the
 * native run runs only when the policy says so. The caller emits the matching
 * `recordExecution` at the very end of the prelude, after the JS fallback has
 * had its turn — that is the span both implementations are compared over.
 */
export const emitNativeRunBlock = (
  route: RouteIR,
  opts: CompilerOptions,
  flags: ValidationFlags,
  needsQuery: boolean,
  needsCookie: boolean,
  needsBody: boolean,
  queryValidated: boolean,
  adaptive = false,
): string[] => {
  const out: string[] = [];
  const bodyGuard =
    needsBody && !flags.hasBodyValidator
      ? `req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS"`
      : null;

  // The shared tail inside `if (__nr) {`: first-failure-wins native body
  // verdicts (400 = not valid JSON, 422 = failed its schema, 413 = oversized —
  // all thrown BEFORE any JS parse, matching the JS prelude's error
  // precedence) + query/cookie/body seeding on success. Emitted at both
  // indentation levels because the adaptive gate adds one nesting level.
  const pushSeedSection = (ind: string): void => {
    if (needsBody) {
      out.push(`${ind}${bodyGuard ? `if (${bodyGuard}) {` : "if (true) {"}`);
      out.push(`${ind}  if (!__nr.ok) {`);
      out.push(`${ind}    if (__nr.errorCode === 400) {`);
      out.push(`${ind}      throw new BodyParseError("Invalid JSON body");`);
      out.push(`${ind}    }`);
      out.push(`${ind}    if (__nr.errorCode === 422) {`);
      out.push(`${ind}      throw validationError(__schema?.body ?? {}, "body");`);
      out.push(`${ind}    }`);
      out.push(`${ind}    if (__nr.errorCode === 413) {`);
      out.push(`${ind}      throw new BodyParseError("Payload too large", 413);`);
      out.push(`${ind}    }`);
      out.push(`${ind}  }`);
      out.push(`${ind}}`);
    }
    out.push(`${ind}if (__nr.ok) {`);
    if (needsQuery) {
      // A schema-validated query becomes the grouped Record the validator
      // consumes; a usage-only query keeps the URLSearchParams contract.
      out.push(
        `${ind}  ${
          queryValidated
            ? `__query = groupQueryPairs(__nr.query);`
            : `ctx.query = new NativeQueryParams(__nr.query);`
        }`,
      );
    }
    if (needsCookie) out.push(`${ind}  __cookies = cookiePairsToRecord(__nr.cookie);`);
    if (needsBody) {
      out.push(
        `${ind}  ${bodyGuard ? `if (${bodyGuard}) { __bodyValidated = true; }` : "__bodyValidated = true;"}`,
      );
    }
    out.push(`${ind}}`);
  };

  out.push(`const __native = ${nativeRouteVar(route)};`);
  if (adaptive) out.push(`let __choice = false;`);
  out.push(`if (__native) {`);
  out.push(`  const __qIdx = req.url.indexOf("?");`);
  out.push(`  let __nr;`);
  if (needsBody) {
    // Bounded read (content-length pre-check + incremental chunked cap) —
    // NEVER an unconditional `req.arrayBuffer()`: that buffers up to Bun's
    // server cap per in-flight request on routes whose real limit is
    // `maxBodyBytes`. A 413 here propagates exactly like the JS body prelude's
    // size guard (same BodyParseError shape). In adaptive mode this read
    // STAYS BEFORE `chooseExecution` — body I/O must not pollute the span
    // both implementations are measured over (parse + validate only).
    out.push(
      `  const __bodyBytes = ${
        bodyGuard
          ? `${bodyGuard} ? await readBodyBounded(req, ${maxBodyLiteral(opts)}) : new Uint8Array(0)`
          : `await readBodyBounded(req, ${maxBodyLiteral(opts)})`
      };`,
    );
  }
  if (adaptive) {
    // Adaptive: components become locals, the policy clock starts at
    // `chooseExecution` (after ALL request I/O), and the native run happens
    // only when the learned decision says so. The caller emits the matching
    // `recordExecution` at the very end of the prelude — after the JS
    // fallback below has had its turn — so both modes are compared over the
    // same parse+validate span.
    out.push(`  const __q = __qIdx < 0 ? "" : req.url.slice(__qIdx + 1);`);
    out.push(`  const __c = req.headers.get("cookie") ?? "";`);
    out.push(
      `  __choice = __native.chooseExecution(__q, __c, ${needsBody ? "__bodyBytes" : "null"});`,
    );
    out.push(`  if (typeof __choice === "boolean" ? __choice : __choice.native) {`);
    out.push(`    try {`);
    // Direct components on the C-ABI; the packed frame stays inside
    // runParts for NAPI, older addons, and embedded-NUL parity.
    out.push(`      __nr = __native.runParts(__q, __c, ${needsBody ? "__bodyBytes" : "null"});`);
    out.push(`    } catch {`);
    out.push(`      __nr = null;`);
    out.push(`    }`);
    out.push(`    if (__nr) {`);
    pushSeedSection("      ");
    out.push(`    }`);
    out.push(`  }`);
  } else {
    out.push(`  try {`);
    out.push(
      `    __nr = __native.runParts(__qIdx < 0 ? "" : req.url.slice(__qIdx + 1), req.headers.get("cookie") ?? "", ${needsBody ? "__bodyBytes" : "null"});`,
    );
    out.push(`  } catch {`);
    out.push(`    __nr = null;`);
    out.push(`  }`);
    out.push(`  if (__nr) {`);
    pushSeedSection("    ");
    out.push(`  }`);
  }
  out.push(`}`);
  return out;
};
