/**
 * @fileoverview Shared contracts for the application overview and its actionable
 * insight findings. These shapes are served by `/api/overview` and consumed by
 * the dashboard and AI summary.
 */

import type { RouteMetrics } from "./observability";

/** Severity assigned to an actionable finding. */
export type InsightSeverity = "info" | "warning" | "critical";

/** Telemetry domain that produced a finding. */
export type InsightCategory = "reliability" | "performance" | "database" | "runtime";

/** Dashboard destination that supplies evidence or a remediation control. */
export interface InsightLink {
  /** Button label. */
  readonly label: string;
  /** Registry view id. */
  readonly view: string;
  /** Optional request/log detail id. */
  readonly id?: string;
  /** Optional request-detail tab. */
  readonly tab?: string;
}

/** One prioritized, evidence-backed application finding. */
export interface Insight {
  /** Stable rule/resource id, suitable for deduplication. */
  readonly id: string;
  readonly severity: InsightSeverity;
  readonly category: InsightCategory;
  readonly title: string;
  /** What was observed, in plain language. */
  readonly detail: string;
  /** Concrete next debugging or remediation step. */
  readonly recommendation: string;
  /** Measured values behind the finding; never prose-only evidence. */
  readonly evidence: Record<string, number | string>;
  /** Direct link to the relevant trace or control panel. */
  readonly link?: InsightLink;
}

/** Headline health values for the retained request window and live process. */
export interface OverviewSummary {
  readonly requests: number;
  readonly failures: number;
  readonly clientErrors: number;
  readonly serverErrors: number;
  readonly failureRatePct: number;
  readonly avgDurationMs: number;
  readonly p95DurationMs: number;
  readonly activeRequests: number;
  readonly dbQueries: number;
  readonly logErrors: number;
  readonly uptimeSec: number;
}

/** Compact failed-request row shown on the overview. */
export interface OverviewFailure {
  readonly id: string;
  readonly ts: number;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  readonly error: string | null;
  readonly faultCode: string | null;
}

/** Coverage facts that qualify the health verdict and prevent blind spots. */
export interface OverviewCoverage {
  readonly retainedTraces: number;
  readonly requestsWithAppSpans: number;
  readonly requestsWithDb: number;
  readonly systemSamples: number;
  readonly persistence: "off" | "on" | "error";
}

/** Complete `GET /api/overview` response. */
export interface DebugOverview {
  readonly checkedAt: number;
  readonly verdict: "ok" | "warning" | "critical";
  readonly summary: OverviewSummary;
  readonly findings: Insight[];
  readonly recentFailures: OverviewFailure[];
  readonly slowRoutes: RouteMetrics[];
  readonly coverage: OverviewCoverage;
}
