/**
 * @fileoverview System view — request totals plus CPU/RSS/heap/event-loop
 * canvas charts fed by the profiler's sample ring. Charts redraw only when a
 * new system revision arrives.
 */

import { type Component, createEffect, createMemo, createSignal, type JSX, Show } from "solid-js";

import { getSystem } from "../api";
import { Panel, StatCard, StatRow } from "../components/widgets";
import { fmtNum } from "../format";
import { baselineFrom, currentPulse, domainMoved, lastRevision } from "../live";

interface ChartSpec {
  key: string;
  color: string;
  label: (v: number) => string;
}

const CHARTS: ChartSpec[] = [
  { key: "cpuPct", color: "var(--err)", label: (v): string => `${v} %` },
  { key: "rssMiB", color: "var(--ok)", label: (v): string => `${v} MiB` },
  { key: "heapMiB", color: "var(--warn)", label: (v): string => `${v} MiB` },
  { key: "eventLoopDelayMs", color: "var(--accent2)", label: (v): string => `${v} ms` },
];

/** Resolve a CSS custom property color to its computed value for canvas. */
const resolveColor = (color: string): string => {
  const match = /^var\((.+)\)$/.exec(color.trim());
  if (match === null) return color;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(match[1] as string)
    .trim();
  return value === "" ? "#888" : value;
};

/** Draw one area chart into a canvas (no-op when the canvas is absent). */
const drawChart = (
  canvas: HTMLCanvasElement | undefined,
  labelEl: HTMLElement | undefined,
  rangeEl: HTMLElement | undefined,
  samples: Array<Record<string, number>>,
  spec: ChartSpec,
): void => {
  if (canvas === undefined || samples.length === 0 || typeof canvas.getContext !== "function")
    return;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;

  const color = resolveColor(spec.color);
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const hgt = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = hgt * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, hgt);

  const vals = samples.map((sample) => sample[spec.key] ?? 0);
  const max = Math.max(...vals, 1);
  const min = Math.min(...vals, 0);
  const span = Math.max(max - min, 1);
  const px = (i: number): number => (i / Math.max(vals.length - 1, 1)) * (w - 4) + 2;
  const py = (v: number): number => hgt - 4 - ((v - min) / span) * (hgt - 8);

  const grad = ctx.createLinearGradient(0, 0, 0, hgt);
  grad.addColorStop(0, color);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.beginPath();
  ctx.moveTo(px(0), py(vals[0] as number));
  for (let i = 1; i < vals.length; i++) ctx.lineTo(px(i), py(vals[i] as number));
  ctx.lineTo(px(vals.length - 1), hgt - 2);
  ctx.lineTo(px(0), hgt - 2);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(px(0), py(vals[0] as number));
  for (let j = 1; j < vals.length; j++) ctx.lineTo(px(j), py(vals[j] as number));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.stroke();

  const last = vals[vals.length - 1] ?? 0;
  if (labelEl !== undefined) labelEl.textContent = spec.label(last);
  if (rangeEl !== undefined)
    rangeEl.textContent = `min ${spec.label(min)} · max ${spec.label(max)}`;
};

/** One chart panel: headline value + range + canvas, redrawn on sample moves. */
const ChartPanel = (props: {
  spec: ChartSpec;
  samples: () => Array<Record<string, number>>;
}): JSX.Element => {
  // Solid's `ref={refs.x}` assigns these after mount.
  const refs = {
    canvas: undefined as HTMLCanvasElement | undefined,
    label: undefined as HTMLElement | undefined,
    range: undefined as HTMLElement | undefined,
  };
  createEffect((): void => {
    drawChart(refs.canvas, refs.label, refs.range, props.samples(), props.spec);
  });
  return (
    <Panel>
      <div class="chart-head">
        <span class="now" ref={refs.label}>
          …
        </span>
        <span class="lbl">{props.spec.key}</span>
        <span class="grow" />
        <span class="range" ref={refs.range} />
      </div>
      <canvas ref={refs.canvas} height={110} />
    </Panel>
  );
};

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
    <div>
      <Show when={stats()} keyed>
        {(s): JSX.Element => {
          const rps = (s.totals.requests / Math.max(s.uptimeSec, 1)).toFixed(1);
          return (
            <StatRow>
              <StatCard
                value={fmtNum(s.totals.requests)}
                label="requests traced"
                sub={`${rps} req/s avg`}
                tone="accent"
              />
              <StatCard
                value={fmtNum(s.totals.errors)}
                label="errors"
                tone={s.totals.errors > 0 ? "err" : undefined}
              />
              <StatCard value={s.totals.avgDurationMs.toFixed(1)} label="avg duration ms" />
              <StatCard value={s.totals.p95DurationMs.toFixed(1)} label="p95 duration ms" />
              <StatCard value={String(s.uptimeSec)} label="uptime s" />
            </StatRow>
          );
        }}
      </Show>
      {CHARTS.map((spec) => (
        <ChartPanel spec={spec} samples={samples} />
      ))}
      <Panel>
        <div class="text-[11.5px] text-muted">
          CPU is process-wide (can exceed 100% on multicore). Event-loop delay is measured with a
          staggered timer.
        </div>
      </Panel>
    </div>
  );
};
