/**
 * @fileoverview Shared chart primitive — owns the canvas series drawing used by
 * the System view. A token-coloured area/line chart is drawn into a fixed-height
 * canvas that redraws whenever the sample ring moves; the current, min and max
 * values are rendered as text in the card head and mirrored on the canvas
 * `aria-label`, so the data is readable without the bitmap (spec §6.6/§6.7).
 */

import { createEffect, createMemo, type JSX } from "solid-js";

import { Card } from "./card";

/** Resolve a CSS custom property colour to its computed value for canvas. */
const resolveColor = (color: string): string => {
  const match = /^var\((.+)\)$/.exec(color.trim());
  if (match === null) return color;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(match[1] as string)
    .trim();
  return value === "" ? "#888" : value;
};

/** Draw one area/line series into a canvas (no-op when the canvas is absent). */
const drawSeries = (canvas: HTMLCanvasElement | undefined, vals: number[], color: string): void => {
  if (canvas === undefined || vals.length === 0 || typeof canvas.getContext !== "function") return;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;

  const stroke = resolveColor(color);
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width <= 0 || height <= 0) return;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const max = Math.max(...vals, 1);
  const min = Math.min(...vals, 0);
  const span = Math.max(max - min, 1);
  const px = (i: number): number => (i / Math.max(vals.length - 1, 1)) * (width - 4) + 2;
  const py = (v: number): number => height - 4 - ((v - min) / span) * (height - 8);

  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, stroke);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.beginPath();
  ctx.moveTo(px(0), py(vals[0] as number));
  for (let i = 1; i < vals.length; i++) ctx.lineTo(px(i), py(vals[i] as number));
  ctx.lineTo(px(vals.length - 1), height - 2);
  ctx.lineTo(px(0), height - 2);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(px(0), py(vals[0] as number));
  for (let j = 1; j < vals.length; j++) ctx.lineTo(px(j), py(vals[j] as number));
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.6;
  ctx.stroke();
};

interface ChartProps {
  /** Chart title, rendered in the card head. */
  title: string;
  /** Unit appended to the displayed values (`%`, `MiB`, `ms`). */
  unit: string;
  /** CSS colour (typically `var(--token)`) for the plotted series. */
  color: string;
  /** Reactive sample ring; each sample is a flat record of numeric fields. */
  samples: () => Array<Record<string, number>>;
  /** The sample field to plot. */
  field: string;
}

/**
 * Fixed-height canvas area chart. The card head shows the current value plus
 * the window min/max as text; the canvas repeats them in its `aria-label`.
 */
export const Chart = (props: ChartProps): JSX.Element => {
  let canvas: HTMLCanvasElement | undefined;

  const vals = createMemo(() => props.samples().map((sample) => sample[props.field] ?? 0));
  const bounds = createMemo(() => {
    const list = vals();
    return { min: Math.min(...list, 0), max: Math.max(...list, 1) };
  });
  const current = createMemo(() => {
    const list = vals();
    return list.length > 0 ? (list[list.length - 1] ?? 0) : 0;
  });
  const withUnit = (value: number): string => `${value} ${props.unit}`;

  createEffect((): void => {
    drawSeries(canvas, vals(), props.color);
  });

  return (
    <Card
      title={props.title}
      hint={
        <span class="flex items-baseline gap-2 font-mono tabular-nums">
          <span class="text-lg font-semibold text-ink">{withUnit(current())}</span>
          <span class="text-xs text-faint">
            {`min ${withUnit(bounds().min)} · max ${withUnit(bounds().max)}`}
          </span>
        </span>
      }
    >
      <div class="h-[120px]">
        <canvas
          ref={(el): void => {
            canvas = el;
          }}
          role="img"
          aria-label={`${props.title}: ${withUnit(current())}, min ${bounds().min}, max ${bounds().max}`}
          class="h-full w-full"
        />
      </div>
    </Card>
  );
};
