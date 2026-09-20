/**
 * @fileoverview System view — request totals in a `StatRow` plus CPU/RSS/heap/
 * event-loop charts from the shared `Chart` primitive, fed by the profiler's
 * sample ring. The `system` domain refetch effect is unchanged.
 */

import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Show,
} from "solid-js";

import { getSystem } from "../api";
import { Card, CardGrid } from "../components/card";
import { Chart } from "../components/chart";
import { PageHeader } from "../components/page";
import { Stat, StatRow } from "../components/stats";
import { fmtNum } from "../format";
import { baselineFrom, currentPulse, domainMoved, lastRevision } from "../live";

interface ChartSpec {
  title: string;
  unit: string;
  color: string;
  field: string;
}

/** The four profiler series, in display order (tokens per spec §6.6). */
const CHARTS: ChartSpec[] = [
  { title: "CPU", unit: "%", color: "var(--err)", field: "cpuPct" },
  { title: "RSS", unit: "MiB", color: "var(--ok)", field: "rssMiB" },
  { title: "Heap", unit: "MiB", color: "var(--warn)", field: "heapMiB" },
  { title: "Event loop", unit: "ms", color: "var(--cat-3)", field: "eventLoopDelayMs" },
];

/** The system panel. */
export const SystemView: Component = () => {
  const [stats, setStats] = createSignal<Awaited<ReturnType<typeof getSystem>> | null>(null);

  const load = (): void => {
    void getSystem()
      .then(setStats)
      .catch((): void => {});
  };
  const baseline = baselineFrom(lastRevision());
  createEffect((): void => {
    if (domainMoved(baseline, "system", currentPulse().rev)) load();
  });

  const samples = createMemo(
    () => (stats()?.samples as unknown as Array<Record<string, number>>) ?? [],
  );

  load();

  return (
    <div class="flex flex-col gap-4">
      <PageHeader title="System" description="Process resource samples from the profiler ring." />
      <Show when={stats()} keyed>
        {(s): JSX.Element => {
          const rps = (s.totals.requests / Math.max(s.uptimeSec, 1)).toFixed(1);
          return (
            <StatRow>
              <Stat
                value={fmtNum(s.totals.requests)}
                label="requests traced"
                sub={`${rps} req/s avg`}
                tone="accent"
              />
              <Stat
                value={fmtNum(s.totals.errors)}
                label="errors"
                tone={s.totals.errors > 0 ? "err" : undefined}
              />
              <Stat value={s.totals.avgDurationMs.toFixed(1)} label="avg duration ms" />
              <Stat value={s.totals.p95DurationMs.toFixed(1)} label="p95 duration ms" />
              <Stat value={String(s.uptimeSec)} label="uptime s" />
            </StatRow>
          );
        }}
      </Show>
      <CardGrid min={320}>
        <For each={CHARTS}>
          {(spec) => (
            <Chart
              title={spec.title}
              unit={spec.unit}
              color={spec.color}
              field={spec.field}
              samples={samples}
            />
          )}
        </For>
      </CardGrid>
      <Card>
        <div class="text-xs text-muted">
          CPU is process-wide (can exceed 100% on multicore). Event-loop delay is measured with a
          staggered timer.
        </div>
      </Card>
    </div>
  );
};
