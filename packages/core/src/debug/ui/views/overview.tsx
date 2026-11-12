/**
 * @fileoverview Application overview — the debugbar landing page. Combines
 * health statistics, prioritized actionable findings, recent failures, route
 * tail latency and instrumentation coverage with direct links to every relevant
 * debugging or control surface.
 */

import { type Component, createEffect, createSignal, For, type JSX, Show } from "solid-js";

import type { DebugOverview, Insight, InsightSeverity } from "../../types";
import { getOverview } from "../api";
import { Badge, type BadgeTone, Chip, MethodBadge, StatusBadge } from "../components/badge";
import { Button } from "../components/button";
import { Callout, type CalloutTone, Card } from "../components/card";
import { Kvs } from "../components/kvs";
import { PageHeader } from "../components/page";
import { EmptyState, ErrorState, LoadingState } from "../components/states";
import { Stat, StatRow } from "../components/stats";
import { DataTable } from "../components/table";
import { fmtMs, fmtNum, fmtUptime, timeAgo, timeHM } from "../format";
import { baselineFrom, currentPulse, type Domain, domainMoved, lastRevision } from "../live";
import { navigate } from "../router";

const SEVERITY_TONE: Record<InsightSeverity, BadgeTone> = {
  info: "info",
  warning: "warn",
  critical: "err",
};

const VERDICT_TONE: Record<DebugOverview["verdict"], CalloutTone> = {
  ok: "ok",
  warning: "warn",
  critical: "err",
};

const LIVE_DOMAINS: Domain[] = ["traces", "logs", "metrics", "system"];

/** One finding with evidence, a concrete recommendation and its drill-down. */
const InsightRow = (props: { finding: Insight }): JSX.Element => (
  <article class="border-b border-line px-4 py-4 last:border-b-0">
    <div class="flex flex-wrap items-center gap-2">
      <Badge tone={SEVERITY_TONE[props.finding.severity]}>{props.finding.severity}</Badge>
      <Chip>{props.finding.category}</Chip>
      <span class="font-mono text-xs text-faint">{props.finding.id}</span>
    </div>
    <h3 class="mt-2 text-lg font-medium text-ink">{props.finding.title}</h3>
    <p class="mt-1 text-sm text-muted">{props.finding.detail}</p>
    <div class="mt-2 flex flex-wrap gap-1.5">
      <For each={Object.entries(props.finding.evidence)}>
        {([key, value]): JSX.Element => <Chip class="font-mono">{`${key}: ${String(value)}`}</Chip>}
      </For>
    </div>
    <div class="mt-3 flex flex-wrap items-center gap-3">
      <p class="max-w-[85ch] text-sm text-ink">{props.finding.recommendation}</p>
      <Show when={props.finding.link}>
        {(link): JSX.Element => (
          <Button
            icon="arrow-right"
            label={link().label}
            onClick={(): void => navigate(link().view, link().id, link().tab)}
          />
        )}
      </Show>
    </div>
  </article>
);

/** The standard application-health and control-panel landing view. */
export const OverviewView: Component = () => {
  const [overview, setOverview] = createSignal<DebugOverview | null>(null);
  const [loaded, setLoaded] = createSignal(false);
  const [loadError, setLoadError] = createSignal<string | null>(null);

  const load = (): void => {
    void getOverview()
      .then((data): void => {
        setOverview(data);
        setLoadError(null);
        setLoaded(true);
      })
      .catch((error: Error): void => {
        setLoadError(error.message);
        setLoaded(true);
      });
  };

  const baseline = baselineFrom(lastRevision());
  let mounted = false;
  createEffect((): void => {
    const pulse = currentPulse();
    if (!mounted) {
      mounted = true;
      load();
      return;
    }
    let moved = false;
    for (const domain of LIVE_DOMAINS) {
      if (domainMoved(baseline, domain, pulse.rev)) moved = true;
    }
    if (moved) load();
  });

  return (
    <div class="flex flex-col gap-4">
      <PageHeader
        title="Overview"
        description="Application health, performance and actionable findings from live telemetry."
        actions={<Button icon="refresh" label="Refresh" onClick={load} />}
      />
      <Show when={!loaded() && overview() === null}>
        <LoadingState />
      </Show>
      <Show when={loadError() !== null}>
        <ErrorState
          message={loadError() ?? ""}
          hint="The overview could not be read. Existing data is kept when a refresh fails."
          onRetry={load}
        />
      </Show>
      <Show when={overview()} keyed>
        {(data): JSX.Element => {
          const s = data.summary;
          const healthTitle =
            data.summary.requests === 0
              ? "Waiting for application traffic"
              : data.verdict === "ok"
                ? "No warnings or critical issues detected"
                : data.verdict === "critical"
                  ? "Critical issues need attention"
                  : "Warnings need review";
          return (
            <>
              <Callout
                tone={data.summary.requests === 0 ? "info" : VERDICT_TONE[data.verdict]}
                title={healthTitle}
              >
                {`${fmtNum(data.coverage.retainedTraces)} retained requests · ${fmtNum(data.coverage.systemSamples)} system samples · history ${data.coverage.persistence}`}
              </Callout>

              <StatRow>
                <Stat value={fmtNum(s.requests)} label="requests" sub="retained window" />
                <Stat
                  value={`${s.failureRatePct.toFixed(1)}%`}
                  label="failure rate"
                  sub={`${fmtNum(s.failures)} thrown or 5xx`}
                  tone={s.failures > 0 ? "err" : "ok"}
                />
                <Stat
                  value={fmtMs(s.p95DurationMs)}
                  label="request p95"
                  sub={`avg ${fmtMs(s.avgDurationMs)}`}
                  tone={s.p95DurationMs >= 1000 ? "warn" : undefined}
                />
                <Stat
                  value={fmtNum(s.activeRequests)}
                  label="active now"
                  sub="in-flight requests"
                  tone={s.activeRequests >= 25 ? "warn" : undefined}
                />
                <Stat value={fmtNum(s.dbQueries)} label="db queries" sub="retained window" />
                <Stat value={fmtUptime(s.uptimeSec)} label="uptime" sub="metrics registry" />
              </StatRow>

              <Card
                pad={false}
                title="Actionable insights"
                description="Prioritized by severity; every finding includes evidence and a next step."
                hint={<Chip>{`${data.findings.length} findings`}</Chip>}
              >
                <Show
                  when={data.findings.length > 0}
                  fallback={
                    <EmptyState
                      icon="check"
                      message="Nothing needs attention in the current telemetry window."
                      hint="Exercise real requests and background jobs; findings appear automatically when a rule has enough evidence."
                    />
                  }
                >
                  <For each={data.findings}>
                    {(finding): JSX.Element => <InsightRow finding={finding} />}
                  </For>
                </Show>
              </Card>

              <div class="grid items-start gap-4 xl:grid-cols-2">
                <Card
                  pad={false}
                  title="Recent failures"
                  description="Thrown errors and 5xx responses."
                >
                  <DataTable
                    label="Recent failures"
                    columns={["When", "Method", "Path", "Status", "Duration"]}
                    rows={data.recentFailures}
                    rowKey={(row): string => row.id}
                    align={[4]}
                    onRowClick={(row): void => navigate("detail", row.id, "error")}
                    render={(row): JSX.Element[] => [
                      <span class="text-muted" title={timeHM(row.ts)}>
                        {timeAgo(row.ts)}
                      </span>,
                      <MethodBadge method={row.method} />,
                      <span class="font-mono" title={row.error ?? row.faultCode ?? undefined}>
                        {row.path}
                      </span>,
                      <StatusBadge status={row.status} />,
                      <span class="font-mono">{fmtMs(row.durationMs)}</span>,
                    ]}
                    empty={<EmptyState icon="check" message="No failed requests retained." />}
                  />
                </Card>

                <Card
                  pad={false}
                  title="Slowest routes"
                  description="Ranked by estimated p95 since boot."
                >
                  <DataTable
                    label="Slowest routes"
                    columns={["Route", "Requests", "p95", "p99", "DB"]}
                    rows={data.slowRoutes}
                    rowKey={(row): string => row.key}
                    align={[1, 2, 3, 4]}
                    onRowClick={(): void => navigate("metrics")}
                    render={(row): JSX.Element[] => [
                      <span class="font-mono">{row.key}</span>,
                      <span class="font-mono">{fmtNum(row.requests)}</span>,
                      <span class="font-mono">{fmtMs(row.p95Ms)}</span>,
                      <span class="font-mono">{fmtMs(row.p99Ms)}</span>,
                      <span class="font-mono text-muted">{fmtNum(row.dbQueries)}</span>,
                    ]}
                    empty={<EmptyState icon="activity" message="No route metrics yet this boot." />}
                  />
                </Card>
              </div>

              <div class="grid items-start gap-4 xl:grid-cols-2">
                <Card
                  title="Instrumentation coverage"
                  description="Use this to avoid mistaking missing telemetry for a healthy app."
                >
                  <Kvs
                    rows={[
                      {
                        k: "Requests with app spans",
                        v: `${data.coverage.requestsWithAppSpans} / ${data.coverage.retainedTraces}`,
                        mono: true,
                      },
                      {
                        k: "Requests with DB capture",
                        v: `${data.coverage.requestsWithDb} / ${data.coverage.retainedTraces}`,
                        mono: true,
                      },
                      { k: "System samples", v: fmtNum(data.coverage.systemSamples), mono: true },
                      { k: "SQLite history", v: data.coverage.persistence, mono: true },
                    ]}
                  />
                </Card>
                <Card
                  title="Application controls"
                  description="Jump to inventory, background work and runtime actions."
                >
                  <div class="flex flex-wrap gap-2">
                    <Button icon="route" label="Routes" onClick={(): void => navigate("routes")} />
                    <Button icon="briefcase" label="Jobs" onClick={(): void => navigate("jobs")} />
                    <Button icon="layers" label="State" onClick={(): void => navigate("state")} />
                    <Button
                      icon="stethoscope"
                      label="Diagnostics & GC"
                      onClick={(): void => navigate("diagnostics")}
                    />
                    <Button
                      icon="radio"
                      label="Event probes"
                      onClick={(): void => navigate("events")}
                    />
                  </div>
                </Card>
              </div>
            </>
          );
        }}
      </Show>
    </div>
  );
};
