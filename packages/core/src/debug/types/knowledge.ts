/**
 * @fileoverview Debugbar Knowledge Tree (KT) types — app knowledge, route map,
 * plugin/lifecycle inventory, docs inventory, DB activity, SDK info and the
 * AI-facing compact summary.
 *
 * Extracted from the pre-split `debug/types.ts` (move-only); the other three
 * domain files are `./trace`, `./api` and `./observability`, all re-exported
 * by `./index`.
 */

import type { SpanKind } from "./trace";

/** Shape of the plugin's captured app knowledge for the KT page. */
export interface AppKnowledge {
  readonly serviceName: string;
  readonly version: string;
  readonly debugMode: boolean;
  readonly environment: Record<string, string>;
  readonly runtime: {
    bunVersion: string;
    platform: string;
    arch: string;
    pid: number;
    nodeEnv: string;
    startedAt: number;
    uptimeSec: number;
  };
  readonly routes: KnowledgeRoute[];
  readonly plugins: KnowledgePlugin[];
  readonly lifecycle: KnowledgeStage[];
  readonly spanKinds: SpanKind[];
  readonly sdk: KnowledgeSdk | null;
  /** Conventional project areas probed on disk — the "where things live" map. */
  readonly areas: KnowledgeArea[];
  /** Markdown docs discovered in the repo — the documentation inventory. */
  readonly docs: KnowledgeDoc[];
  /**
   * DB activity aggregated over the retained request traces (normalized
   * statements with call counts, total time and the routes that ran them).
   */
  readonly dbActions: KnowledgeDbAction[];
  readonly notes: string[];
}

/** One route in the KT route map. */
export interface KnowledgeRoute {
  readonly method: string;
  readonly path: string;
  readonly file: string | null;
  readonly description: string;
  /** Human summary of the context members the handler touches. */
  readonly usage: string[];
  readonly isConstant: boolean;
  readonly hooks: string[];
}

/** One registered plugin in the KT inventory. */
export interface KnowledgePlugin {
  readonly name: string;
  readonly description: string;
}

/** One lifecycle stage with its hook count. */
export interface KnowledgeStage {
  readonly name: string;
  readonly hookCount: number;
  readonly order: number;
}

/** One conventional project area in the KT "where things live" map. */
export interface KnowledgeArea {
  readonly name: string;
  /** Directory that was probed (relative to the app root). */
  readonly dir: string;
  /** What this area is for, in onboarding language. */
  readonly description: string;
  /** Total files found under the area (recursive, any extension). */
  readonly fileCount: number;
  /** Sample of the files found (relative to the area), capped for display. */
  readonly files: string[];
}

/** One markdown document discovered for the KT documentation inventory. */
export interface KnowledgeDoc {
  /** Repo-relative path (the stable identifier — docs move less than URLs). */
  readonly path: string;
  /** Title from the first `#` heading; falls back to the file name. */
  readonly title: string;
}

/** One doc served by the Debugbar Docs panel (`GET /api/docs?path=`). */
export interface DocPayload {
  readonly path: string;
  readonly title: string;
  readonly markdown: string;
  /** Sanitized server-rendered HTML; null when the renderer is unavailable. */
  readonly html: string | null;
}

/** Aggregated DB activity for one normalized SQL pattern. */
export interface KnowledgeDbAction {
  /** Leading SQL keyword uppercased (`SELECT`, `INSERT`, …). */
  readonly action: string;
  /** First table referenced (`from`/`into`/`update`/`join`), when parseable. */
  readonly table: string | null;
  /** Statement shape with literals replaced by `?` and whitespace collapsed. */
  readonly statement: string;
  /** How many times it ran inside the retained traces. */
  readonly calls: number;
  /** Sum of span durations (ms) across those calls. */
  readonly totalMs: number;
  /** Route patterns observed performing this action (capped sample). */
  readonly routes: string[];
}

/** Published-SDK metadata shown on the KT page. */
export interface KnowledgeSdk {
  readonly name: string;
  readonly version: string;
  readonly location: string;
  readonly files: string[];
  /** Git tags matching the SDK tag prefix (`sdk-v*`), newest first. */
  readonly gitTags: string[];
  /** `tagged` when a matching git tag exists (the `ignex sdk --push` signal). */
  readonly published: "tagged" | "local" | "unknown";
}

/**
 * Compact AI-facing debug summary served at `{path}/api/ai/summary`.
 *
 * One small JSON document that tells an AI agent (via MCP) what is happening
 * on this server right now: error/slow traces, event-queue stats and published
 * clients. Designed to be cheap to fetch and cheap to read — the agent then
 * drills into specific traces with the per-request endpoints.
 */
export interface AiDebugSummary {
  readonly service: string;
  readonly version: string;
  readonly environment: string;
  readonly uptimeSec: number;
  readonly traces: {
    readonly total: number;
    readonly errors: number;
    readonly avgDurationMs: number;
    readonly p95DurationMs: number;
    /** Most recent failed requests (compact rows). */
    readonly recentErrors: Array<{
      id: string;
      ts: number;
      method: string;
      path: string;
      status: number;
      error: string;
    }>;
    /** Slowest retained requests. */
    readonly slowest: Array<{
      id: string;
      ts: number;
      method: string;
      path: string;
      durationMs: number;
      status: number;
    }>;
  };
  readonly events: {
    readonly enabled: boolean;
    readonly connected: boolean;
    readonly total: number;
    readonly errors: number;
    readonly bySubject: Record<string, number>;
  };
  readonly clients: Array<{
    readonly kind: string;
    readonly platform: string | null;
    readonly name: string;
    readonly version: string;
    readonly published: string;
    readonly gitTags: readonly string[];
  }>;
  /**
   * Nova (FlatBuffer realtime transport) event activity — present when the
   * app wires `data.nova` into the debugbar. What fired recently, at a glance.
   */
  readonly nova?: {
    /** trace ring active on the running nova server */
    readonly enabled: boolean;
    /** records currently retained by the ring */
    readonly size: number;
    readonly total: number;
    readonly inCount: number;
    readonly outCount: number;
    /** per-event counts over the retained window */
    readonly byName: Record<string, number>;
    /** most recent fired events, newest first (compact rows) */
    readonly recent: Array<{
      ts: number;
      direction: string;
      name: string;
      target?: string;
      key?: string;
      bytes: number;
    }>;
  };
  /**
   * Observatory addendum — leak verdict, recent warnings and persistence
   * state, so an agent can decide where to dig next without extra calls.
   */
  readonly observatory?: {
    readonly verdict: "ok" | "warning" | "critical";
    readonly findings: Array<{
      readonly id: string;
      readonly severity: "info" | "warning" | "critical";
      readonly title: string;
    }>;
    /** Current heap trend (MiB/min; ~0 when healthy). */
    readonly heapMiBPerMin: number;
    readonly logErrors: number;
    readonly recentWarnings: Array<{
      readonly ts: number;
      readonly level: string;
      readonly message: string;
      readonly traceId?: string;
    }>;
    readonly persist: { readonly enabled: boolean; readonly path: string | null };
  };
  readonly routes: number;
}

/** Options for {@link KnowledgeBuilder}. */
export interface KnowledgeOptions {
  readonly serviceName: string;
  readonly version?: string;
  /** AOT manifest.json artifact path(s) to read the route map from. */
  readonly manifestPaths?: string[];
  /** SDK package/location probes (directory containing package.json or the json itself). */
  readonly sdkPaths?: string[];
  /**
   * Directories scanned for the documentation inventory (markdown files, two
   * levels deep). Defaults to `["docs", "."]` relative to {@link projectRoot}.
   */
  readonly docsPaths?: string[];
  /** App root the project map + docs scan probe. Default `process.cwd()`. */
  readonly projectRoot?: string;
  /** Lifecycle stage inventory (name → hook count), in execution order. */
  readonly lifecycle?: Record<string, number>;
  readonly plugins?: string[];
}
