/**
 * @fileoverview Metrics view — totals/gauge cards, per-route aggregates and
 * the Prometheus scrape panel. Live via the `metrics` domain.
 */

import { type Component, createEffect, createSignal, For, type JSX, Show } from "solid-js";

import { BASE, getMetrics } from "../api";
import { EmptyState, Panel, StatCard, StatRow } from "../components/widgets";
import { durClass, fmtMs, fmtNum, timeAgo, timeHM } from "../format";
import { baselineFrom, currentPulse, domainMoved, lastRevision } from "../live";
import { copyAttr } from "./copy-attr";

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
    <div>
      <Show when={snap()} keyed>
        {(m): JSX.Element => {
          const t = m.totals;
          const errRate = t.requests > 0 ? `${((t.errors / t.requests) * 100).toFixed(1)}%` : "—";
          const g = m.gauges;
          return (
            <>
              <StatRow>
                <StatCard
                  value={fmtNum(t.requests)}
                  label="requests"
                  sub={`since boot (${String(m.uptimeSec)}s up)`}
                />
                <StatCard
                  value={errRate}
                  label="error rate"
                  sub={`${fmtNum(t.errors)} errors`}
                  tone={t.errors > 0 ? "err" : "ok"}
                />
                <StatCard
                  value={fmtNum(t.status4xx)}
                  label="4xx"
                  tone={t.status4xx > 0 ? "warn" : undefined}
                />
                <StatCard
                  value={fmtNum(t.status5xx)}
                  label="5xx"
                  tone={t.status5xx > 0 ? "err" : undefined}
                />
                <StatCard value={fmtNum(t.dbQueries)} label="db queries" sub="total" />
              </StatRow>
              <StatRow>
                <StatCard
                  value={
                    g.process_rss_mib !== undefined && g.process_rss_mib !== null
                      ? g.process_rss_mib.toFixed(1)
                      : "—"
                  }
                  label="rss MiB"
                  sub="now"
                />
                <StatCard
                  value={
                    g.process_heap_used_mib !== undefined && g.process_heap_used_mib !== null
                      ? g.process_heap_used_mib.toFixed(1)
                      : "—"
                  }
                  label="heap MiB"
                  sub="now"
                />
                <StatCard
                  value={
                    g.event_loop_delay_ms !== undefined && g.event_loop_delay_ms !== null
                      ? g.event_loop_delay_ms.toFixed(1)
                      : "—"
                  }
                  label="loop delay ms"
                  sub="last sample"
                />
                <StatCard
                  value={fmtNum(g.active_requests ?? 0)}
                  label="active reqs"
                  sub="in flight"
                />
              </StatRow>
              <Panel
                title="Per-route aggregates"
                hint={
                  <span class="hint">busiest first · p50/p95/p99 estimated from histograms</span>
                }
              >
                <table>
                  <thead>
                    <tr>
                      {["Route", "Reqs", "Err", "p50", "p95", "p99", "DB", "Last"].map((l) => (
                        <th>{l}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {m.routes.length > 0 ? (
                      <For each={m.routes}>
                        {(r): JSX.Element => (
                          <tr>
                            <td class="font-mono">{r.key}</td>
                            <td class="font-mono">{String(r.requests)}</td>
                            <td class={`font-mono ${r.errors > 0 ? "text-err" : "text-muted"}`}>
                              {String(r.errors)}
                            </td>
                            <td class={`font-mono ${durClass(r.p50Ms)}`}>{fmtMs(r.p50Ms)}</td>
                            <td class={`font-mono ${durClass(r.p95Ms)}`}>{fmtMs(r.p95Ms)}</td>
                            <td class={`font-mono ${durClass(r.p99Ms)}`}>{fmtMs(r.p99Ms)}</td>
                            <td class="font-mono text-muted">
                              {r.dbQueries > 0 ? `${String(r.dbQueries)}q · ${fmtMs(r.dbMs)}` : "—"}
                            </td>
                            <td class="text-muted" title={timeHM(r.lastTs)}>
                              {timeAgo(r.lastTs)}
                            </td>
                          </tr>
                        )}
                      </For>
                    ) : (
                      <tr>
                        <td colspan={8}>
                          <EmptyState glyph="📈" message="No requests observed yet this boot." />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </Panel>
              <Show when={m.counters.length > 0}>
                <Panel title="Custom counters">
                  <table>
                    <thead>
                      <tr>
                        {["Name", "Labels", "Value"].map((l) => (
                          <th>{l}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <For each={m.counters}>
                        {(c): JSX.Element => (
                          <tr>
                            <td class="font-mono">{c.name}</td>
                            <td class="font-mono text-muted">
                              {Object.keys(c.labels).length > 0 ? JSON.stringify(c.labels) : "—"}
                            </td>
                            <td class="font-mono">{String(c.value)}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Panel>
              </Show>
              <Panel
                title="Grafana / Prometheus"
                headExtra={
                  <button type="button" class="ghost mini" {...copyAttr(promUrl)}>
                    copy scrape URL
                  </button>
                }
              >
                <div>
                  <div class="prom-url">
                    <code>{promUrl}</code>
                  </div>
                  <p class="hint mt-2">
                    Point a Prometheus scrape_config at that URL (metrics_path:
                    /__debugbar/api/metrics/prometheus, header x-debugbar-token when token-gated)
                    and build Grafana panels on ignex_http_request_duration_ms_*,
                    ignex_http_requests_total and ignex_process_*_mib.
                  </p>
                </div>
              </Panel>
            </>
          );
        }}
      </Show>
    </div>
  );
};
