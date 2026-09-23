/**
 * @fileoverview Requests + Errors views — live trace table built from the page
 * primitives: `PageHeader` (title/description/actions) → `StatRow` → sticky
 * `Toolbar` (search + method/status filters) → `DataTable` → state slots. Rows
 * render through a keyed identity merge so stream bumps only add the rows that
 * changed instead of rebuilding a 200-row table; module-scoped stores keep the
 * live row set and filters across view remounts.
 */

import {
  type Accessor,
  type Component,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  onCleanup,
  type Setter,
  Show,
  untrack,
} from "solid-js";

import type { TraceSummary } from "../../store";
import { clearRequests, getRequests } from "../api";
import { Chip, MethodBadge, StatusBadge } from "../components/badge";
import { Button } from "../components/button";
import { Card } from "../components/card";
import { SearchInput, Select } from "../components/fields";
import { mergeById } from "../components/keyed";
import { PageHeader, Toolbar } from "../components/page";
import { EmptyState, ErrorState } from "../components/states";
import { Stat, StatRow } from "../components/stats";
import { DataTable } from "../components/table";
import { BarRow, BarTrack } from "../components/widgets";
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

/** Table column labels, in `DataTable` render order. */
const HEADERS = ["When", "Method", "Path", "Status", "Duration", "DB", "Spans", "Error"];

/** Methods offered by the toolbar's method filter. */
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** Status families offered by the toolbar's status filter. */
const STATUS_FAMILIES = ["2xx", "3xx", "4xx", "5xx"];

/**
 * Module-scoped stores so the live row set + filters survive view remounts.
 * Solid disposes a view's reactive graph when the route changes (tab switch);
 * keeping the list here means the Requests/Errors panels never wipe their
 * rows, and `seenIds` is shared so returning rows don't re-flash as "fresh".
 */
interface ListStore {
  rows: Accessor<Map<string, TraceSummary>>;
  setRows: Setter<Map<string, TraceSummary>>;
  q: Accessor<string>;
  setQ: Setter<string>;
  method: Accessor<string>;
  setMethod: Setter<string>;
  status: Accessor<string>;
  setStatus: Setter<string>;
  /** Exact fault-code filter (`IGN_DB_CREDENTIALS`) — one failure mode at a time. */
  code: Accessor<string>;
  setCode: Setter<string>;
  /** Ids already shown — flash newly arrived rows exactly once. */
  seenIds: Set<string>;
}

const createListStore = (): ListStore => {
  const [rows, setRows] = createSignal<Map<string, TraceSummary>>(new Map());
  const [q, setQ] = createSignal("");
  const [method, setMethod] = createSignal("");
  const [status, setStatus] = createSignal("");
  const [code, setCode] = createSignal("");
  return {
    rows,
    setRows,
    q,
    setQ,
    method,
    setMethod,
    status,
    setStatus,
    code,
    setCode,
    seenIds: new Set(),
  };
};

const reqStore = createListStore();
const errStore = createListStore();

/**
 * Live size of the Errors window the Errors view has loaded. The sidebar's
 * Errors badge reads this; an unvisited Errors view (or a zero count) hides
 * the badge.
 */
export const liveErrorCount = (): number => errStore.rows().size;

/** Shared builder for the Requests and Errors surfaces. */
const ListView = (props: { errorsOnly: boolean }): JSX.Element => {
  const s = props.errorsOnly ? errStore : reqStore;
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [loaded, setLoaded] = createSignal(false);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  onCleanup((): void => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
  });

  const load = (): void => {
    void getRequests({
      q: untrack(s.q),
      method: untrack(s.method),
      status: untrack(s.status),
      code: untrack(s.code),
      errorsOnly: props.errorsOnly,
      limit: 200,
    })
      .then((data): void => {
        setLoadError(null);
        s.setRows((prev) => mergeById(prev, data, (r) => r.id));
        setLoaded(true);
      })
      .catch((err: Error): void => {
        setLoadError(err.message);
        setLoaded(true);
      });
  };

  // Live tail: fetch once on mount (so returning to the tab shows the current
  // window immediately — the revision baseline is re-seeded from the CURRENT
  // counters, so a first-run domainMoved check would be a no-op and leave the
  // panel empty until the next request arrives or the user hits refresh), then
  // refetch whenever the traces domain moves (or a full-refresh pulse lands).
  let mounted = false;
  const baseline = baselineFrom(lastRevision());
  createEffect((): void => {
    const pulse = currentPulse();
    if (!mounted) {
      mounted = true;
      load();
      return;
    }
    if (domainMoved(baseline, "traces", pulse.rev)) load();
  });

  // Derived window stats (recomputed only when rows change).
  const stats = createMemo(() => {
    const list = [...s.rows().values()];
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

  const rowsList = createMemo(() => [...s.rows().values()]);

  /** Distinct fault codes in the window — the failure modes worth filtering by. */
  const faultCodes = createMemo(() =>
    [...new Set([...s.rows().values()].map((r) => r.fault?.code))]
      .filter((code): code is string => typeof code === "string")
      .sort(),
  );

  /** Report whether `id` is new (and remember it) — the fresh-row flash hook. */
  const isFresh = (id: string): boolean => {
    const fresh = !s.seenIds.has(id);
    s.seenIds.add(id);
    return fresh;
  };

  /**
   * One `DataTable` row, one node per column (the primitive wraps each in a
   * `<td>`). Bar length is relative to the SLOWEST request in the window so
   * the distribution is comparable at a glance.
   */
  const rowCells = (row: TraceSummary): JSX.Element[] => {
    const barColor =
      row.status >= 500 ? "var(--err)" : row.status >= 400 ? "var(--warn)" : undefined;
    return [
      <span class="text-muted" title={timeHM(row.ts)}>
        {timeAgo(row.ts)}
      </span>,
      <MethodBadge method={row.method} />,
      <span class="font-mono">{row.path}</span>,
      <StatusBadge status={row.status} />,
      <BarRow>
        <span class={`font-mono ${durClass(row.durationMs)}`}>{fmtMs(row.durationMs)}</span>
        <BarTrack
          pct={Math.max(Math.min((row.durationMs / stats().maxDur) * 100, 100), 1.5)}
          color={barColor}
        />
      </BarRow>,
      <span class="font-mono text-muted">
        {row.dbCount > 0 ? `${fmtMs(row.dbTimeMs)} · ${row.dbCount}q` : "—"}
      </span>,
      <span class="font-mono text-muted">{String(row.spanCount)}</span>,
      <span class="block max-w-[240px] truncate" title={row.error ?? undefined}>
        {row.fault ? (
          <Chip class="mr-1 font-mono" title="fault code" dataCopy={row.fault.code}>
            {row.fault.code}
          </Chip>
        ) : null}
        <span class={row.error !== null ? "text-err" : "text-muted"}>{row.error ?? "—"}</span>
      </span>,
    ];
  };

  return (
    <div class="flex flex-col gap-4">
      <PageHeader
        title={props.errorsOnly ? "Errors" : "Requests"}
        description="Live trace ring — newest first, last 200"
        actions={
          <>
            <Button
              icon={paused() ? "play" : "pause"}
              label={paused() ? "Resume live" : "Pause live"}
              ariaPressed={paused()}
              onClick={(): void => {
                setPaused(!paused());
              }}
            />
            <Button icon="refresh" label="Refresh" onClick={(): void => pushPulse()} />
            <Button
              variant="danger"
              icon="trash"
              label="Clear"
              onClick={(): void => {
                void clearRequests().then((): void => {
                  toast("store cleared");
                  load();
                });
              }}
            />
          </>
        }
      />

      <StatRow>
        <Stat
          value={fmtNum(stats().count)}
          label={props.errorsOnly ? "Errors (window)" : "Requests (window)"}
          sub="last 200"
        />
        <Stat
          value={fmtNum(stats().errs)}
          label="Errors"
          tone={stats().errs > 0 ? "err" : undefined}
        />
        <Stat
          value={fmtNum(stats().n4xx)}
          label="4xx"
          tone={stats().n4xx > 0 ? "warn" : undefined}
        />
        <Stat
          value={fmtNum(stats().n5xx)}
          label="5xx"
          tone={stats().n5xx > 0 ? "err" : undefined}
        />
        <Stat value={stats().avg} label="avg ms" sub="this window" />
      </StatRow>

      <Toolbar sticky>
        <SearchInput
          id="search"
          placeholder="filter method / path / error / fault code…"
          value={s.q()}
          onInput={(value): void => {
            s.setQ(value);
            if (debounceTimer !== null) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(load, 250);
          }}
        />
        <Select
          id="method-filter"
          onChange={(ev): void => {
            s.setMethod(ev.currentTarget.value);
            load();
          }}
        >
          <option value="">all methods</option>
          {METHODS.map((m) => (
            <option value={m}>{m}</option>
          ))}
        </Select>
        <Select
          id="status-filter"
          onChange={(ev): void => {
            s.setStatus(ev.currentTarget.value);
            load();
          }}
        >
          <option value="">all statuses</option>
          {STATUS_FAMILIES.map((family) => (
            <option value={family}>{family}</option>
          ))}
        </Select>
        <Show when={faultCodes().length > 0}>
          <Select
            id="code-filter"
            value={s.code()}
            onChange={(ev): void => {
              s.setCode(ev.currentTarget.value);
              load();
            }}
          >
            <option value="">all fault codes</option>
            {faultCodes().map((code) => (
              <option value={code}>{code}</option>
            ))}
          </Select>
        </Show>
      </Toolbar>

      <Card pad={false}>
        <DataTable
          label={props.errorsOnly ? "Errors" : "Requests"}
          columns={HEADERS}
          rows={rowsList()}
          rowKey={(row): string => row.id}
          render={rowCells}
          rowClass={(row): string | undefined => (isFresh(row.id) ? "row-fresh" : undefined)}
          align={[4, 5, 6]}
          onRowClick={(row): void => navigate("detail", row.id)}
          loading={!loaded() && rowsList().length === 0}
          empty={
            <EmptyState
              icon="activity"
              message={props.errorsOnly ? "No errors in the window" : "No requests in the window"}
              hint="New rows appear here as traffic arrives."
            />
          }
        />
      </Card>

      <Show when={loadError() !== null}>
        <ErrorState
          message={loadError() ?? ""}
          hint="Is the debugbar enabled and the server running?"
          onRetry={load}
        />
      </Show>
    </div>
  );
};

/** Requests panel (live ring). */
export const RequestsView: Component = () => <ListView errorsOnly={false} />;

/** Errors-only variant of the requests panel. */
export const ErrorsView: Component = () => <ListView errorsOnly={true} />;
