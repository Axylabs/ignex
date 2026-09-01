/**
 * @fileoverview Logs view — structured observatory log stream with level/text
 * filters, SQLite-persisted mode and clear. Live tail via the `logs` domain.
 */

import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Show,
  untrack,
} from "solid-js";

import { clearLogs, getLogs } from "../api";
import { mergeById } from "../components/keyed";
import {
  EmptyState,
  LevelPill,
  Panel,
  rowKeyHandler,
  StatCard,
  StatRow,
} from "../components/widgets";
import { fmtNum, timeAgo, timeHM } from "../format";
import { baselineFrom, currentPulse, domainMoved, lastRevision } from "../live";
import { navigate } from "../router";
import { toast } from "../toast";

interface LogRow {
  id: number;
  ts: number;
  level: string;
  source: string;
  message: string;
  attrs?: unknown;
  traceId: string | null;
}

/** One log row (keyed by record id). */
const LogRowView = (props: { row: LogRow }): JSX.Element => (
  <tr
    title="click for full record"
    class="cursor-pointer"
    tabIndex={0}
    onClick={(): void => navigate("logDetail", String(props.row.id))}
    onKeyDown={rowKeyHandler((): void => navigate("logDetail", String(props.row.id)))}
  >
    <td class="text-muted" title={timeHM(props.row.ts)}>
      {timeAgo(props.row.ts)}
    </td>
    <td>
      <LevelPill level={props.row.level} />
    </td>
    <td class="text-muted">{props.row.source}</td>
    <td class="log-msg font-mono" title={props.row.message}>
      {props.row.message}
      {props.row.attrs !== null && props.row.attrs !== undefined ? (
        <span class="log-attrs">{JSON.stringify(props.row.attrs)}</span>
      ) : null}
    </td>
    <td>
      {props.row.traceId !== null ? (
        <a
          class="trace-link"
          href={`#/requests/${encodeURIComponent(props.row.traceId ?? "")}/waterfall`}
          onClick={(ev): void => {
            ev.preventDefault();
            navigate("detail", props.row.traceId ?? "", "waterfall");
          }}
        >
          request ↗
        </a>
      ) : (
        <span class="text-faint">—</span>
      )}
    </td>
  </tr>
);

/**
 * Module-scoped store so the log window + filters survive view remounts (tab
 * switches) — otherwise the list is wiped and, since the revision baseline is
 * re-seeded from the CURRENT counters on mount, stays empty until the next
 * log line or a manual refresh.
 */
const [records, setRecords] = createSignal<Map<string, LogRow>>(new Map());
const [stats, setStats] = createSignal<{ warn: number; error: number } | null>(null);
const [q, setQ] = createSignal("");
const [level, setLevel] = createSignal("");
const [persisted, setPersisted] = createSignal(false);

/** The logs panel. */
export const LogsView: Component = () => {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const load = (): void => {
    void getLogs({
      q: untrack(q) || undefined,
      level: untrack(level) || undefined,
      persisted: untrack(persisted),
      limit: 300,
    })
      .then((res): void => {
        setRecords((prev) => mergeById(prev, res.records as LogRow[], (r) => String(r.id)));
        setStats(res.stats);
      })
      .catch((): void => {
        setRecords(new Map());
      });
  };

  // Live tail: fetch once on mount (same rationale as requests.tsx — the
  // revision baseline is re-seeded from the CURRENT counters, so a first-run
  // domainMoved check would be a no-op), then refetch whenever the logs
  // domain moves (or a full-refresh pulse lands).
  let mounted = false;
  const baseline = baselineFrom(lastRevision());
  createEffect((): void => {
    const pulse = currentPulse();
    if (!mounted) {
      mounted = true;
      load();
      return;
    }
    if (domainMoved(baseline, "logs", pulse.rev)) load();
  });

  const recordsList = createMemo(() => [...records().values()]);

  return (
    <div>
      <StatRow>
        <StatCard
          value={fmtNum(recordsList().length)}
          label="logs (window)"
          sub={persisted() ? "from SQLite history" : "live ring"}
        />
        <StatCard
          value={fmtNum(stats()?.warn ?? 0)}
          label="warns"
          tone={(stats()?.warn ?? 0) > 0 ? "warn" : undefined}
        />
        <StatCard
          value={fmtNum(stats()?.error ?? 0)}
          label="errors"
          tone={(stats()?.error ?? 0) > 0 ? "err" : undefined}
        />
      </StatRow>

      <Panel>
        <div class="toolbar">
          <input
            class="search"
            id="search"
            type="text"
            placeholder="filter messages…"
            value={q()}
            onInput={(ev): void => {
              setQ((ev.target as HTMLInputElement).value);
              if (debounceTimer !== null) clearTimeout(debounceTimer);
              debounceTimer = setTimeout(load, 250);
            }}
          />
          <select
            onChange={(ev): void => {
              setLevel((ev.target as HTMLSelectElement).value);
              load();
            }}
          >
            <option value="">all levels</option>
            <option value="debug">debug+</option>
            <option value="info">info+</option>
            <option value="warn">warn+</option>
            <option value="error">error only</option>
          </select>
          <label class="muted flex items-center gap-1.5 text-[11.5px]">
            <input
              type="checkbox"
              checked={persisted()}
              onChange={(ev): void => {
                setPersisted((ev.target as HTMLInputElement).checked);
                load();
              }}
            />
            SQLite
          </label>
          <span class="grow" />
          <button type="button" class="ghost mini" onClick={(): void => load()}>
            ↻ refresh
          </button>
          <button
            type="button"
            class="ghost mini"
            onClick={(): void => {
              void clearLogs().then((): void => {
                toast("log ring cleared");
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
              {["When", "Level", "Source", "Message", "Trace"].map((l) => (
                <th>{l}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <For each={recordsList()}>{(row): JSX.Element => <LogRowView row={row} />}</For>
          </tbody>
        </table>
        <Show when={recordsList().length === 0}>
          <EmptyState
            glyph="🗒"
            message="No logs captured yet."
            hint='Call ctx.debug.log("warn", "…") or debugLog() anywhere, or just console.log — it is mirrored here.'
          />
        </Show>
      </Panel>
    </div>
  );
};
