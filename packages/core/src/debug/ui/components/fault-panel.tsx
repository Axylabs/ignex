/**
 * @fileoverview Fault panel — the classification card behind a failed request.
 *
 * It renders the SAME taxonomy the terminal report prints (`renderFault` in
 * `platform/fault-report.ts`): which subsystem broke (origin · service), what
 * kind of failure it was, the stable fault code, the retryable verdict, the
 * operator hints ("what to fix"), the sanitized cause chain, the structured
 * environment issues and the first application frame.
 *
 * The stack is deliberately SECONDARY: the classification answers "what broke
 * and what do I do" in one glance, and the stack is there for when that is not
 * enough. Wire types come from the shared debug types (type-only import), so
 * the dashboard can never drift from the fault the server recorded.
 */

import { For, type JSX, Show } from "solid-js";

import type { TraceFault, TraceFrames } from "../../types";
import { Badge, type BadgeTone, Chip, CountChip } from "./badge";
import { Button } from "./button";
import { Card } from "./card";
import { Kvs, type KvsRow } from "./kvs";

/** Origin → tone: whose fault is it? (ours = err, caller's = info). */
const ORIGIN_TONE: Record<string, BadgeTone> = {
  app: "err",
  internal: "err",
  db: "err",
  network: "err",
  dependency: "err",
  native: "err",
  config: "warn",
  auth: "warn",
  request: "info",
};

/** One line of a bulleted section (hints, causes, env issues). */
const Bullet = (props: { children: JSX.Element }): JSX.Element => (
  <li class="flex gap-2 text-sm text-muted">
    <span aria-hidden="true" class="text-faint">
      •
    </span>
    <span class="min-w-0 break-words">{props.children}</span>
  </li>
);

/** `MongoServerError: Command create requires authentication (code 13)`. */
const causeLine = (cause: TraceFault["causes"][number]): string =>
  `${cause.name}: ${cause.message}${cause.code === undefined ? "" : ` (code ${cause.code})`}`;

/**
 * The fault as copy-pasteable text — the same sections the terminal report
 * prints, so pasting it into an issue (or to a teammate) loses nothing.
 *
 * @param fault - The classified failure.
 * @returns The plain-text report.
 */
export const faultToText = (fault: TraceFault, frames?: TraceFrames | null | undefined): string => {
  const appWhere = frames?.appWhere;
  const lines = [
    `code     ${fault.code} · ${fault.origin}${
      fault.service === undefined ? "" : ` · ${fault.service}`
    }`,
    `what     ${fault.summary}`,
    ...(fault.message.length > 0 ? [`message  ${fault.message}`] : []),
    ...(appWhere === undefined ? [] : [`in code  ${appWhere}`]),
    ...(fault.where === undefined || fault.where === appWhere ? [] : [`raised   ${fault.where}`]),
    ...(fault.detail === undefined ? [] : [`detail   ${fault.detail}`]),
    `retry    ${
      fault.retryable ? "yes — the same request may succeed later" : "no — fix the cause first"
    }`,
  ];
  if (fault.hints.length > 0) lines.push("", "What to fix", ...fault.hints.map((h) => `  • ${h}`));
  if (fault.causes.length > 0) {
    lines.push("", "Cause chain (innermost last)", ...fault.causes.map((c) => `  ${causeLine(c)}`));
  }
  if (fault.issues.length > 0) {
    lines.push("", "Configuration check", ...fault.issues.map((i) => `  ${i.key} ${i.message}`));
  }
  return lines.join("\n");
};

/** Identity rows: what broke, in the driver's own (already redacted) words. */
const faultRows = (fault: TraceFault, frames: TraceFrames | null | undefined): KvsRow[] => {
  const appWhere = frames?.appWhere;
  const rows: KvsRow[] = [
    { k: "what", v: fault.summary },
    ...(fault.message.length > 0 ? [{ k: "message", v: fault.message }] : []),
    // The location in YOUR code leads — that is the frame to open first.
    ...(appWhere === undefined ? [] : [{ k: "in your code", v: appWhere, mono: true }]),
    // The fault's own frame is the deepest one that names a file, which for a
    // dependency error is a dependency. Shown second, and only when it is not
    // already the application frame.
    ...(fault.where === undefined || fault.where === appWhere
      ? []
      : [{ k: "raised in", v: fault.where, mono: true }]),
    ...(fault.detail === undefined ? [] : [{ k: "detail", v: fault.detail }]),
    {
      k: "retry",
      v: fault.retryable ? "yes — the same request may succeed later" : "no — fix the cause first",
    },
  ];
  return rows;
};

/**
 * One group of stack frames. The internals group is rendered collapsed: the
 * business frame is what the reader acts on, the machinery is there to explain
 * it when they need to go deeper.
 *
 * @param props.title - Group heading (`Your code`, `Framework & dependencies`).
 * @param props.lines - Frame lines, in capture order.
 * @param props.empty - Text shown when the group has no frames.
 * @param props.collapsed - Render behind a disclosure (default closed).
 */
export const FrameGroup = (props: {
  title: string;
  lines: readonly string[];
  empty: string;
  collapsed?: boolean | undefined;
}): JSX.Element => (
  <div class="flex flex-col gap-1">
    <div class="flex items-center gap-2">
      <span class="text-xs uppercase tracking-wide text-faint">{props.title}</span>
      <CountChip n={props.lines.length} />
    </div>
    <Show when={props.lines.length > 0} fallback={<p class="text-sm text-muted">{props.empty}</p>}>
      <Show
        when={props.collapsed === true}
        fallback={<pre class="err-stack">{props.lines.join("\n")}</pre>}
      >
        <details>
          <summary class="cursor-pointer text-xs text-muted">
            {`show ${props.lines.length} frame${props.lines.length === 1 ? "" : "s"}`}
          </summary>
          <pre class="err-stack">{props.lines.join("\n")}</pre>
        </details>
      </Show>
    </Show>
  </div>
);

/**
 * The Error tab's classification card.
 *
 * @param props.fault - The classified failure recorded on the trace.
 * @param props.frames - The failure's frames, business logic first, when the
 *   trace captured them.
 */
export const FaultPanel = (props: {
  fault: TraceFault;
  frames?: TraceFrames | null | undefined;
}): JSX.Element => {
  const appWhere = (): string | undefined => props.frames?.appWhere;
  return (
    <>
      <Card
        title="Fault"
        actions={
          <Button
            size="sm"
            icon="copy"
            label="Copy"
            dataCopy={faultToText(props.fault, props.frames)}
          />
        }
      >
        <div class="flex flex-col gap-3">
          <div class="flex flex-wrap items-center gap-1.5">
            <Badge tone={ORIGIN_TONE[props.fault.origin] ?? "err"}>
              {props.fault.origin}
              {props.fault.service === undefined ? "" : ` · ${props.fault.service}`}
            </Badge>
            <Badge tone="neutral">{props.fault.kind}</Badge>
            <Chip class="font-mono" title="fault code — click to copy" dataCopy={props.fault.code}>
              {props.fault.code}
            </Chip>
            <Chip title="HTTP status the boundary answered with">{String(props.fault.status)}</Chip>
            <Chip title="error name">{props.fault.errorName}</Chip>
          </div>
          <Kvs rows={faultRows(props.fault, props.frames)} />
          <Show when={appWhere() !== undefined && appWhere() !== props.fault.where}>
            <p class="text-xs text-muted">
              Start at <span class="font-mono text-ink">in your code</span> — the failure was raised
              inside the framework or a dependency that carried it.
            </p>
          </Show>
        </div>
      </Card>

      <Show when={props.fault.hints.length > 0}>
        <Card title="What to fix">
          <ul class="flex list-none flex-col gap-1.5 p-0">
            <For each={props.fault.hints}>{(hint): JSX.Element => <Bullet>{hint}</Bullet>}</For>
          </ul>
        </Card>
      </Show>

      <Show when={props.fault.causes.length > 0}>
        <Card title="Cause chain (innermost last)">
          <ul class="flex list-none flex-col gap-1.5 p-0">
            <For each={props.fault.causes}>
              {(cause): JSX.Element => <Bullet>{causeLine(cause)}</Bullet>}
            </For>
          </ul>
        </Card>
      </Show>

      <Show when={props.fault.issues.length > 0}>
        <Card title="Configuration check">
          <ul class="flex list-none flex-col gap-1.5 p-0">
            <For each={props.fault.issues}>
              {(issue): JSX.Element => (
                <Bullet>
                  <span class="font-mono">{issue.key}</span>
                  {` ${issue.message}`}
                </Bullet>
              )}
            </For>
          </ul>
        </Card>
      </Show>
    </>
  );
};
