/**
 * @fileoverview Metrics view — totals/gauge tiles in a single `StatGrid`,
 * per-route and custom-counter `DataTable`s (numerics right-aligned) and the
 * Prometheus scrape card. Live via the `metrics` domain; the fetch/refetch
 * effect is unchanged.
 */

import { type Component, createEffect, createSignal, type JSX, Show } from "solid-js";

import { BASE, getMetrics } from "../api";
import { Button } from "../components/button";
import { Card } from "../components/card";
import { PageHeader } from "../components/page";
import { EmptyState } from "../components/states";
import { Stat, StatGrid } from "../components/stats";
import { DataTable } from "../components/table";
import { durClass, fmtMs, fmtNum, timeAgo, timeHM } from "../format";
import { baselineFrom, currentPulse, domainMoved, lastRevision } from "../live";

/** Gauge value with one decimal (`—` when the gauge is missing). */
const fmtGauge = (value: number | null | undefined): string =>
  value === null || value === undefined ? "—" : value.toFixed(1);

/** The metrics panel. */
export const MetricsView: Component = () => {
  const [snap, setSnap] = createSignal<Awaited<ReturnType<typeof getMetrics>> | null>(null);

  const load = (): void => {
    void getMetrics()
      .then(setSnap)
      .catch((): void => {});
  };

  const baseline = baselineFrom(lastRevision());
  createEffect((): void => {
    if (domainMoved(baseline, "metrics", currentPulse().rev)) load();
  });

  const promUrl = `${window.location.origin}${BASE.replace(/\/$/, "")}/api/metrics/prometheus`;

  return (
    <div class="flex flex-col gap-4">
      <PageHeader
        title="Metrics"
        description="Observatory counters, per-route aggregates and the Prometheus scrape endpoint."
        actions={<Button icon="copy" label="copy scrape URL" dataCopy={promUrl} />}
      />
      <Show when={snap()} keyed>
        {(m): JSX.Element => {
          const t = m.totals;
          const errRate = t.requests > 0 ? `${((t.errors / t.requests) * 100).toFixed(1)}%` : "—";
          const g = m.gauges;
          return (
            <>
              <StatGrid>
                <Stat
                  value={fmtNum(t.requests)}
                  label="requests"
                  sub={`since boot (${String(m.uptimeSec)}s up)`}
                />
                <Stat
                  value={errRate}
                  label="error rate"
                  sub={`${fmtNum(t.errors)} errors`}
                  tone={t.errors > 0 ? "err" : "ok"}
                />
                <Stat
                  value={fmtNum(t.status4xx)}
                  label="4xx"
                  tone={t.status4xx > 0 ? "warn" : undefined}
                />
                <Stat
                  value={fmtNum(t.status5xx)}
                  label="5xx"
                  tone={t.status5xx > 0 ? "err" : undefined}
                />
                <Stat value={fmtNum(t.dbQueries)} label="db queries" sub="total" />
                <Stat value={fmtGauge(g.process_rss_mib)} label="rss MiB" sub="now" />
                <Stat value={fmtGauge(g.process_heap_used_mib)} label="heap MiB" sub="now" />
                <Stat
                  value={fmtGauge(g.event_loop_delay_ms)}
                  label="loop delay ms"
                  sub="last sample"
                />
                <Stat value={fmtNum(g.active_requests ?? 0)} label="active reqs" sub="in flight" />
              </StatGrid>

              <Card
                pad={false}
                title="Per-route aggregates"
                hint={
                  <span class="text-xs text-faint">
                    busiest first · p50/p95/p99 estimated from histograms
                  </span>
                }
              >
                <DataTable
                  label="Per-route aggregates"
                  columns={["Route", "Reqs", "Err", "p50", "p95", "p99", "DB", "Last"]}
                  rows={m.routes}
                  rowKey={(r): string => r.key}
                  align={[1, 2, 3, 4, 5, 6]}
                  render={(r): JSX.Element[] => [
                    <span class="font-mono">{r.key}</span>,
                    <span class="font-mono">{String(r.requests)}</span>,
                    <span class={`font-mono ${r.errors > 0 ? "text-err" : "text-muted"}`}>
                      {String(r.errors)}
                    </span>,
                    <span class={`font-mono ${durClass(r.p50Ms)}`}>{fmtMs(r.p50Ms)}</span>,
                    <span class={`font-mono ${durClass(r.p95Ms)}`}>{fmtMs(r.p95Ms)}</span>,
                    <span class={`font-mono ${durClass(r.p99Ms)}`}>{fmtMs(r.p99Ms)}</span>,
                    <span class="font-mono text-muted">
                      {r.dbQueries > 0 ? `${String(r.dbQueries)}q · ${fmtMs(r.dbMs)}` : "—"}
                    </span>,
                    <span class="text-muted" title={timeHM(r.lastTs)}>
                      {timeAgo(r.lastTs)}
                    </span>,
                  ]}
                  empty={
                    <EmptyState icon="activity" message="No requests observed yet this boot." />
                  }
                />
              </Card>

              <Show when={m.counters.length > 0}>
                <Card pad={false} title="Custom counters">
                  <DataTable
                    label="Custom counters"
                    columns={["Name", "Labels", "Value"]}
                    rows={m.counters}
                    rowKey={(c): string => c.name}
                    align={[2]}
                    render={(c): JSX.Element[] => [
                      <span class="font-mono">{c.name}</span>,
                      <span class="font-mono text-muted">
                        {Object.keys(c.labels).length > 0 ? JSON.stringify(c.labels) : "—"}
                      </span>,
                      <span class="font-mono">{String(c.value)}</span>,
                    ]}
                  />
                </Card>
              </Show>

              <Card
                title="Grafana / Prometheus"
                headExtra={
                  <Button variant="icon" icon="copy" title="copy scrape URL" dataCopy={promUrl} />
                }
              >
                <div>
                  <div class="overflow-x-auto rounded-md border border-line bg-surface-3 px-2.5 py-1.5 font-mono text-xs text-ink">
                    <code>{promUrl}</code>
                  </div>
                  <p class="mt-2 text-xs text-faint">
                    Point a Prometheus scrape_config at that URL (metrics_path:
                    /__debugbar/api/metrics/prometheus, header x-debugbar-token when token-gated)
                    and build Grafana panels on ignex_http_request_duration_ms_*,
                    ignex_http_requests_total and ignex_process_*_mib.
                  </p>
                </div>
              </Card>
            </>
          );
        }}
      </Show>
    </div>
  );
};
