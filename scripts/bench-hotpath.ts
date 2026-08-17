#!/usr/bin/env bun
/**
 * AOT hot-path micro-benchmark harness.
 *
 * Stress-tests the individual functions of the COMPILED server in isolation
 * so we can find unnecessary allocations / GC pressure / unoptimal code and
 * A/B proposed fixes. Two kinds of targets:
 *
 *   1. Generated code  — the codegen `HELPER_SOURCES` templates from
 *      `packages/compiler/src/phases/codegen/helpers.ts` are evaled in an
 *      isolated scope (exact emitted code, minus Bun.serve). Baseline rows
 *      always reflect the CURRENT generated templates.
 *   2. Core runtime    — the shared `@ignex/core` fns the compiled server
 *      calls (`createContext`, `applySet`, `runHooks`, `parseQueryFromURL`,
 *      `parseCookieString`, `parseQuery`).
 *
 * Every row has a `current` (baseline) and an `optimized` variant. Trials are
 * interleaved (A/B/A/B) with `Bun.gc()` between them; the reported number is
 * the MEDIAN of `TRIALS`. Keep an optimization only when it wins >= WIN_RATIO
 * here (then port it into the codegen template / core runtime).
 *
 * Usage:
 *   bun scripts/bench-hotpath.ts                # all groups
 *   bun scripts/bench-hotpath.ts reply          # filter by group name
 *   bun scripts/bench-hotpath.ts --json         # machine-readable JSON
 */
import { HELPER_SOURCES } from "../packages/compiler/src/phases/codegen/helpers";
import {
  applySet,
  createContext,
  parseCookieString,
  parseQuery,
  parseQueryFromURL,
  runHooks,
} from "../packages/core/src";

// ── CLI ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const AS_JSON = args.includes("--json");
const FILTER = args.filter((a) => !a.startsWith("--"))[0];

// ── Tunables ───────────────────────────────────────────────────────────
const DURATION_MS = 200; // timed window per trial (keeps the loop fast)
const TRIALS = 5; // interleaved trials per variant (median reported)
const WARMUP = 2_000; // iterations before timing
const WIN_RATIO = 1.05; // keep optimized only if ratio >= this

// ── Synthetic fixtures (deterministic) ─────────────────────────────────
const URL_STR = "http://localhost:9123/api/users?page=2&limit=20&sort=name&q=hello+world";
const QUERY_STR = "page=2&limit=20&sort=name&q=hello+world";
const COOKIE_STR = "sid=session_123; theme=dark; lang=en; a=1; b=2; c=3; d=4";
const JSON_BODY = {
  ok: true,
  requestId: "request_1",
  path: "/api/users",
  query: { page: "2", limit: "20" },
  cookies: { sid: "session_123" },
};
const ERR_JSON = { ok: false, error: { code: "rate_limited", message: "Too Many Requests" } };

const enc = new TextEncoder();
const jsonBytes = enc.encode(JSON.stringify(JSON_BODY));
const req = new Request(URL_STR, { method: "GET" });
const bodyLimits = Object.freeze({
  maxJsonBytes: 2097152,
  maxTextBytes: 2097152,
  maxFormBytes: 2097152,
  maxFileBytes: 20971520,
});
const params = Object.freeze({});

// A real Response for applySet benches (headers mutable under Bun).
const resp = new Response(jsonBytes, { headers: { "content-type": "application/json" } });
const EMPTY_SET = Object.freeze({ headers: Object.freeze({}) });

// ── Timing helpers ─────────────────────────────────────────────────────
/** Measure ops/sec for a synchronous fn (warmup + timed loop). */
function opsPerSec(fn: () => void, durationMs = DURATION_MS): number {
  for (let i = 0; i < WARMUP; i++) fn();
  const start = performance.now();
  let count = 0;
  while (performance.now() - start < durationMs) {
    fn();
    count++;
  }
  return count / ((performance.now() - start) / 1000);
}

/** Median of an array. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

interface Variant {
  name: string;
  fn: () => unknown;
}

/** Bench one group of variants: interleaved trials, Bun.gc() between. */
function benchGroup(name: string, variants: Variant[]): Record<string, number> {
  const results: Record<string, number> = {};
  const samples: Record<string, number[]> = {};
  for (const v of variants) samples[v.name] = [];

  for (let t = 0; t < TRIALS; t++) {
    // Interleave variants within a trial so thermal/JIT drift hits both.
    for (const v of variants) {
      if (typeof Bun !== "undefined" && Bun.gc) Bun.gc();
      samples[v.name]?.push(opsPerSec(v.fn));
    }
  }

  for (const v of variants) results[v.name] = median(samples[v.name]);

  const baseline = results[variants[0]?.name];
  const rows = variants.map((v) => {
    const r = results[v.name];
    const ratio = baseline > 0 ? r / baseline : Number.NaN;
    return { name: v.name, ops: r, ratio };
  });

  if (AS_JSON) return results;
  console.log(`\n== ${name} ==`);
  for (const row of rows) {
    const delta = (row.ratio - 1) * 100;
    const mark = row.ratio >= WIN_RATIO ? " ✅" : row.ratio <= 1 / WIN_RATIO ? " ❌" : "";
    console.log(
      `${row.name.padEnd(24)} ${String(Math.round(row.ops)).padStart(10)} ops/s` +
        `  x${row.ratio.toFixed(3)}  (${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%)${mark}`,
    );
  }
  return results;
}

// ── Generated-code scope ───────────────────────────────────────────────
// Eval the codegen helper templates exactly as emitted (baseline = current).
const MODULE_PRELUDE = `
const EMPTY_PARAMS = Object.freeze({});
const BODY_LIMITS = Object.freeze({
  maxJsonBytes: 2097152, maxTextBytes: 2097152, maxFormBytes: 2097152, maxFileBytes: 20971520,
});
const __encoder = new TextEncoder();
const __TRACE = false;
const __ACCESS_LOG = false;
const __lc = { error: [], afterResponse: [], trace: [] };
const __preStages = [];
const __postStages = [];
const __allowedStatic = Object.freeze({});
const __allowedDynamic = [];
`;

const HELPERS_ORDER = [
  "__withBody",
  "jsonReply",
  "textReply",
  "htmlReply",
  "__finalize",
  "__applySet",
  "__handleError",
  "__isServerLike",
  "__extractParams",
  "__extractServer",
  "__wrap",
  "__head",
  "__allowFor",
  "__optionsHandler",
  "__fallback",
];

/** Evaluate a set of helper sources into a scope object. */
function evalHelpers(
  sources: Record<string, string>,
  core: Record<string, unknown>,
  prelude = MODULE_PRELUDE,
): Record<string, unknown> {
  const body = HELPERS_ORDER.filter((h) => sources[h])
    .map((h) => sources[h])
    .join("\n\n");
  const factory = new Function(
    ...Object.keys(core),
    `${prelude}\n${body}\nreturn { ${HELPERS_ORDER.join(", ")} };`,
  );
  return factory(...Object.values(core)) as Record<string, unknown>;
}

const coreScope = {
  applySet,
  runHooks,
  createContext,
  errorToResponse: (err: unknown) =>
    new Response(JSON.stringify({ error: String(err) }), { status: 500 }),
  validateAsync: async () => undefined,
};

const helpers = evalHelpers(HELPER_SOURCES, coreScope);
const helper = (name: string) => helpers[name] as (...a: unknown[]) => unknown;

// ── Variants ───────────────────────────────────────────────────────────
// Each group: variant[0] = current/baseline (live HELPER_SOURCES), variant[1+]
// = proposed fixes. Once a fix wins >= WIN_RATIO it is ported into the
// template/core, and the `optimized` row here is updated to the NEXT candidate
// (or removed).
//
// Applied so far (now in live HELPER_SOURCES / core runtime):
//   P1.2 hoisted __encoder; P1.3 __finalize skips {status} at 200;
//   P1.4 __withBody plain-object headers fast path (no Headers/rest/spread).
// Next candidates (fill as written):

const optimizedHelpers: Record<string, string> = {};

const optHelpers = Object.keys(optimizedHelpers).length
  ? evalHelpers({ ...HELPER_SOURCES, ...optimizedHelpers }, coreScope)
  : null;

// Typed accessor for an optimized helper variant (evaluated code is `unknown`).
type ReplyFn = (...a: unknown[]) => Response;
const optHelper = (name: string): ReplyFn =>
  (optHelpers?.[name] as ReplyFn | undefined) ??
  (() => {
    throw new Error(`no optimized helper: ${name}`);
  });

type Group = { name: string; variants: Variant[] };
const groups: Group[] = [];

// ── reply: compiled __withBody / jsonReply / __finalize ────────────────
groups.push({
  name: "reply.__withBody (no init)",
  variants: [
    {
      name: "current",
      fn: () => helper("__withBody")(jsonBytes, "application/json; charset=utf-8", undefined),
    },
    ...(optHelpers
      ? [
          {
            name: "optimized",
            fn: () => optHelper("__withBody")(jsonBytes, "application/json; charset=utf-8"),
          },
        ]
      : []),
  ],
});

groups.push({
  name: "reply.jsonReply",
  variants: [
    { name: "current", fn: () => helper("jsonReply")(JSON_BODY, undefined) },
    ...(optHelpers ? [{ name: "optimized", fn: () => optHelper("jsonReply")(JSON_BODY) }] : []),
  ],
});

groups.push({
  name: "reply.jsonReply {status:429}",
  variants: [
    { name: "current", fn: () => helper("jsonReply")(ERR_JSON, { status: 429 }) },
    ...(optHelpers
      ? [{ name: "optimized", fn: () => optHelper("jsonReply")(ERR_JSON, { status: 429 }) }]
      : []),
  ],
});

groups.push({
  name: "reply.__finalize (200)",
  variants: [
    {
      name: "current",
      fn: () => helper("__finalize")(JSON_BODY, { set: EMPTY_SET }, undefined, helper("jsonReply")),
    },
    ...(optHelpers
      ? [
          {
            name: "optimized",
            fn: () =>
              optHelper("__finalize")(
                JSON_BODY,
                { set: EMPTY_SET },
                undefined,
                optHelper("jsonReply"),
              ),
          },
        ]
      : []),
  ],
});

// ── context: createContext ─────────────────────────────────────────────
groups.push({
  name: "context.createContext",
  variants: [
    {
      name: "current",
      fn: () => createContext(req, params, { body: bodyLimits, route: "/api/users" }),
    },
  ],
});

// ── applySet ───────────────────────────────────────────────────────────
groups.push({
  name: "applySet (no-op fast path)",
  variants: [{ name: "current", fn: () => applySet(resp, undefined) }],
});

groups.push({
  name: "applySet (header mutation)",
  variants: [
    {
      name: "current",
      fn: () => applySet(resp, { headers: { "x-request-id": "req_1" }, cookie: {} }),
    },
  ],
});

// ── runHooks ───────────────────────────────────────────────────────────
const syncHook = (ctx: unknown) => {
  (ctx as { set?: Record<string, unknown> }).set ??= {};
  return undefined;
};
const syncHook3 = (ctx: unknown) => {
  (ctx as { set?: Record<string, unknown> }).set ??= {};
  return undefined;
};
const ctxLike = { set: { headers: {}, cookie: {} } } as unknown as Parameters<typeof runHooks>[1];
const hookChain = [syncHook, syncHook3, syncHook] as unknown as Parameters<typeof runHooks>[0];

// NOTE: a sync fast path for `runHooks` (skip the per-hook `await` when a hook
// returns a non-thenable) was TRIALLED and REJECTED — it measured SLOWER
// (x0.91): JSC already optimizes `await` on sync values, and the thenable
// check adds overhead. Keeping only the current implementation as the row.

groups.push({
  name: "runHooks (empty chain)",
  variants: [{ name: "current", fn: () => runHooks([], ctxLike) }],
});

groups.push({
  name: "runHooks (3 sync hooks)",
  variants: [{ name: "current", fn: () => runHooks(hookChain, ctxLike) }],
});

// ── parsers ────────────────────────────────────────────────────────────
groups.push({
  name: "parse.queryFromURL",
  variants: [{ name: "current", fn: () => parseQueryFromURL(URL_STR) }],
});

groups.push({
  name: "parse.cookieString (7 cookies)",
  variants: [{ name: "current", fn: () => parseCookieString(COOKIE_STR) }],
});

groups.push({
  name: "parse.parseQuery (JS scalar)",
  variants: [{ name: "current", fn: () => parseQuery(QUERY_STR) }],
});

// Bun-native URLSearchParams iteration (the `url.searchParams` path).
const searchParams = new URL(URL_STR).searchParams;
groups.push({
  name: "parse.searchParams->record (Bun native)",
  variants: [
    {
      name: "current",
      fn: () => {
        const out: Record<string, string | string[]> = {};
        for (const [k, v] of searchParams) {
          const existing = out[k];
          if (existing === undefined) out[k] = v;
          else if (Array.isArray(existing)) existing.push(v);
          else out[k] = [existing, v];
        }
        return out;
      },
    },
  ],
});

// ── run ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (!AS_JSON) {
    console.log("AOT hot-path bench — interleaved trials, median, Bun.gc() between");
    console.log(`  bun ${process.version ?? ""}  ·  win threshold x${WIN_RATIO}`);
  }

  const all: Record<string, Record<string, number>> = {};
  for (const g of groups) {
    if (FILTER && !g.name.includes(FILTER)) continue;
    all[g.name] = benchGroup(g.name, g.variants);
  }

  if (AS_JSON) console.log(JSON.stringify(all, null, 2));
}

await main();
