/**
 * @fileoverview Requests + Errors views — live trace table with stat cards,
 * text/method/status filters, pause/resume and clear. Rows render through a
 * keyed identity merge so stream bumps only add the rows that changed instead
 * of rebuilding a 200-row table.
 */

import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  Show,
  untrack,
} from "solid-js";

import type { TraceSummary } from "../../store";
import { clearRequests, getRequests } from "../api";
import { mergeById } from "../components/keyed";
import {
  BarRow,
  BarTrack,
  EmptyState,
  MethodPill,
  Panel,
  rowKeyHandler,
  StatCard,
  StatRow,
  StatusPill,
} from "../components/widgets";
import { durClass, fmtMs, fmtNum, timeAgo, timeHM } from "../format";
import {
  baselineFrom,
  currentPulse,
  domainMoved,
  lastRevision,
  paused,
  pushPulse,
  setPaused,
} from "../live";
import { navigate } from "../router";
import { toast } from "../toast";

const HEADERS = ["When", "Method", "Path", "Status", "Duration", "DB", "Spans", "Error"];

/** One trace row (keyed by trace id; fresh rows flash once). */
const TraceRow = (props: {
  row: TraceSummary;
  maxDur: () => number;
  seenIds: Set<string>;
}): JSX.Element => {
  const fresh = !props.seenIds.has(props.row.id);
  props.seenIds.add(props.row.id);
  // Bar length is relative to the SLOWEST request in the window so the
  // distribution is comparable at a glance.
  const pct = createMemo((): number => {
    const max = props.maxDur();
    return Math.max(Math.min((props.row.durationMs / max) * 100, 100), 1.5);
  });
  const barColor =
    props.row.status >= 500 ? "var(--err)" : props.row.status >= 400 ? "var(--warn)" : undefined;
  return (
    <tr
      data-id={props.row.id}
      class={fresh ? "fresh" : ""}
      title={timeHM(props.row.ts)}
      tabIndex={0}
      onClick={(): void => navigate("detail", props.row.id)}
      onKeyDown={rowKeyHandler((): void => navigate("detail", props.row.id))}
    >
      <td class="text-muted" title={timeHM(props.row.ts)}>
        {timeAgo(props.row.ts)}
      </td>
      <td>
        <MethodPill method={props.row.method} />
      </td>
      <td class="font-mono">{props.row.path}</td>
      <td>
        <StatusPill status={props.row.status} />
      </td>
      <td>
        <BarRow>
          <span class={`font-mono ${durClass(props.row.durationMs)}`}>
            {fmtMs(props.row.durationMs)}
          </span>
          <BarTrack pct={pct()} color={barColor} />
        </BarRow>
      </td>
      <td class="font-mono text-muted">
        {props.row.dbCount > 0 ? `${fmtMs(props.row.dbTimeMs)} · ${props.row.dbCount}q` : "—"}
      </td>
      <td class="font-mono text-muted">{String(props.row.spanCount)}</td>
      <td class="text-muted">
        {props.row.error !== null ? <span class="pill status err">{props.row.error}</span> : "—"}
      </td>
    </tr>
  );
};

/** Shared builder for the Requests and Errors surfaces. */
const ListView = (props: { errorsOnly: boolean }): JSX.Element => {
  const [rows, setRows] = createSignal<Map<string, TraceSummary>>(new Map());
  const [q, setQ] = createSignal("");
  const [method, setMethod] = createSignal("");
  const [status, setStatus] = createSignal("");
  const [loadError, setLoadError] = createSignal<string | null>(null);

  // Ids already shown — used to flash newly arrived rows exactly once.
  const seenIds = new Set<string>();

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  onCleanup((): void => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
  });

  const load = (): void => {
    void getRequests({
      q: untrack(q),
      method: untrack(method),
      status: untrack(status),
      errorsOnly: props.errorsOnly,
      limit: 200,
    })
      .then((data): void => {
        setLoadError(null);
        setRows((prev) => mergeById(prev, data, (r) => r.id));
      })
      .catch((err: Error): void => {
        setLoadError(err.message);
      });
  };

  // Live tail: refetch when the traces domain moves (or full-refresh pulses).
  const baseline = baselineFrom(lastRevision());
  createEffect((): void => {
    if (domainMoved(baseline, "traces", currentPulse().rev)) load();
  });

  // Derived window stats (recomputed only when rows change).
  const stats = createMemo(() => {
    const list = [...rows().values()];
    let n4xx = 0;
    let n5xx = 0;
    let errs = 0;
    let totalMs = 0;
    let maxDur = 0;
    for (const row of list) {
      if (row.status >= 500) n5xx++;
      else if (row.status >= 400) n4xx++;
      if (row.error !== null) errs++;
      totalMs += row.durationMs;
      if (row.durationMs > maxDur) maxDur = row.durationMs;
    }
    return {
      count: list.length,
      errs,
      n4xx,
      n5xx,
      avg: list.length > 0 ? (totalMs / list.length).toFixed(1) : "0",
      maxDur: Math.max(maxDur, 0.001),
    };
  });

  const rowsList = createMemo(() => [...rows().values()]);

  return (
    <div>
      <StatRow>
        <StatCard
          value={fmtNum(stats().count)}
          label={props.errorsOnly ? "Errors (window)" : "Requests (window)"}
          sub="last 200"
        />
        <StatCard
          value={fmtNum(stats().errs)}
          label="Errors"
          tone={stats().errs > 0 ? "err" : undefined}
        />
        <StatCard
          value={fmtNum(stats().n4xx)}
          label="4xx"
          tone={stats().n4xx > 0 ? "warn" : undefined}
        />
        <StatCard
          value={fmtNum(stats().n5xx)}
          label="5xx"
          tone={stats().n5xx > 0 ? "err" : undefined}
        />
        <StatCard value={stats().avg} label="avg ms" sub="this window" />
      </StatRow>

      <Panel>
        <div class="toolbar">
          <input
            class="search"
            id="search"
            type="text"
            placeholder="filter method / path / error…"
            value={q()}
            onInput={(ev): void => {
              setQ((ev.target as HTMLInputElement).value);
              if (debounceTimer !== null) clearTimeout(debounceTimer);
              debounceTimer = setTimeout(load, 250);
            }}
          />
          <select
            id="method-filter"
            onChange={(ev): void => {
              setMethod((ev.target as HTMLSelectElement).value);
              load();
            }}
          >
            <option value="">all methods</option>
            {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((m) => (
              <option value={m}>{m}</option>
            ))}
          </select>
          <select
            id="status-filter"
            onChange={(ev): void => {
              setStatus((ev.target as HTMLSelectElement).value);
              load();
            }}
          >
            <option value="">all statuses</option>
            {["2xx", "3xx", "4xx", "5xx"].map((s) => (
              <option value={s}>{s}</option>
            ))}
          </select>
          <span class="grow" />
          <button
            type="button"
            class="ghost mini"
            id="pause"
            onClick={(): void => {
              setPaused(!paused());
            }}
          >
            ⏸/▶ live
          </button>
          <button type="button" class="ghost mini" onClick={(): void => pushPulse()}>
            ↻ refresh
          </button>
          <button
            type="button"
            class="ghost mini"
            onClick={(): void => {
              void clearRequests().then((): void => {
                toast("store cleared");
                load();
              });
            }}
          >
            ✕ clear
          </button>
        </div>
      </Panel>

      <Panel>
        <table>
          <thead>
            <tr>
              {HEADERS.map((label) => (
                <th>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <For each={rowsList()}>
              {(row): JSX.Element => (
                <TraceRow row={row} maxDur={(): number => stats().maxDur} seenIds={seenIds} />
              )}
            </For>
          </tbody>
        </table>
      </Panel>

      <Show when={loadError() !== null}>
        <Panel>
          <EmptyState
            glyph="⚠"
            message={loadError() ?? ""}
            hint="Is the debugbar enabled and the server running?"
          />
        </Panel>
      </Show>
    </div>
  );
};

/** Requests panel (live ring). */
export const RequestsView: Component = () => <ListView errorsOnly={false} />;

/** Errors-only variant of the requests panel. */
export const ErrorsView: Component = () => <ListView errorsOnly={true} />;
