/**
 * @fileoverview History view — persisted traces from the SQLite observatory on
 * the page primitives: `PageHeader` (title/description + refresh) →
 * `StatRow` (only while persistence is live) → `Toolbar` (text/status/min-ms
 * filters) → `DataTable` → states. Deep links resolve the history source by
 * fallback in the request detail; the archive survives restarts.
 */

import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  Show,
  untrack,
} from "solid-js";

import { getHistory, getMeta, type HistoryList } from "../api";
import { MethodBadge, StatusBadge } from "../components/badge";
import { Button } from "../components/button";
import { Card } from "../components/card";
import { SearchInput, Select } from "../components/fields";
import { mergeById } from "../components/keyed";
import { PageHeader, Toolbar } from "../components/page";
import { EmptyState, ErrorState } from "../components/states";
import { Stat, StatRow } from "../components/stats";
import { DataTable } from "../components/table";
import { durClass, fmtMs, fmtNum, timeAgo, timeHM } from "../format";
import { navigate } from "../router";

/** Table column labels, in `DataTable` render order. */
const HEADERS = ["When", "Method", "Path", "Status", "Duration", "DB", "Error"];

/** Status families offered by the history toolbar's status filter. */
const STATUS_FAMILIES = ["2xx", "3xx", "4xx", "5xx"];

/** Token-styled box shared with `SearchInput` (used for the min-ms field). */
const FIELD_BOX =
  "h-8 min-w-0 rounded-md border border-line bg-surface-3 px-2.5 text-md text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25";

/** The history panel. */
export const HistoryView: Component = () => {
  const [rows, setRows] = createSignal<Map<string, HistoryList["rows"][number]>>(new Map());
  const [q, setQ] = createSignal("");
  const [status, setStatus] = createSignal("");
  const [minMs, setMinMs] = createSignal("");
  const [unavailable, setUnavailable] = createSignal(false);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [loaded, setLoaded] = createSignal(false);

  const load = (): void => {
    void getHistory({
      q: untrack(q) || undefined,
      status: untrack(status) || undefined,
      minMs: untrack(minMs) || undefined,
      errorsOnly: false,
      limit: 200,
    })
      .then((res): void => {
        setLoadError(null);
        setRows((prev) => mergeById(prev, res.rows ?? [], (r) => r.id));
        setLoaded(true);
      })
      .catch((err: Error): void => {
        setRows(new Map());
        setLoadError(err.message);
        setLoaded(true);
      });
  };

  const rowsList = createMemo(() => [...rows().values()]);

  const errs = createMemo(() =>
    rowsList().reduce((acc, row) => acc + (row.error !== null ? 1 : 0), 0),
  );

  // Availability gate (persist off / bun:sqlite unavailable).
  createEffect((): void => {
    void getMeta()
      .then((meta): void => {
        if ((meta.features?.history ?? false) === false) setUnavailable(true);
      })
      .catch((): void => {});
  });

  load();

  /**
   * One `DataTable` row, one node per column (the primitive wraps each in a
   * `<td>`); the error cell truncates with a `title` so long errors do not
   * stretch the table.
   */
  const rowCells = (r: HistoryList["rows"][number]): JSX.Element[] => [
    <span class="text-muted" title={timeHM(r.ts)}>
      {timeAgo(r.ts)}
    </span>,
    <MethodBadge method={r.method} />,
    <span class="font-mono">{r.path}</span>,
    <StatusBadge status={r.status} />,
    <span class={`font-mono ${durClass(r.durationMs)}`}>{fmtMs(r.durationMs)}</span>,
    <span class="font-mono text-muted">
      {r.dbCount > 0 ? `${String(r.dbCount)}q · ${fmtMs(r.dbTimeMs)}` : "—"}
    </span>,
    <span
      class={`block max-w-[240px] truncate${r.error !== null ? " text-err" : " text-muted"}`}
      title={r.error ?? undefined}
    >
      {r.error ?? "—"}
    </span>,
  ];

  return (
    <div class="flex flex-col gap-4">
      <PageHeader
        title="History"
        description="Persisted traces from the SQLite archive — they survive restarts"
        actions={<Button icon="refresh" label="Refresh" onClick={(): void => load()} />}
      />

      <Show
        when={!unavailable()}
        fallback={
          <Card>
            <EmptyState
              icon="database"
              message="Persisted history unavailable."
              hint="Enable persistence with debugbar({ persist: true }) (default on in debug mode) and make sure bun:sqlite is available. Everything recorded from then on lands in .ignex/observatory.db and survives restarts."
            />
          </Card>
        }
      >
        <StatRow>
          <Stat value={fmtNum(rowsList().length)} label="history rows" sub="newest first" />
          <Stat value={fmtNum(errs())} label="with errors" tone={errs() > 0 ? "err" : undefined} />
        </StatRow>

        <Toolbar>
          <SearchInput
            id="search"
            placeholder="filter method / path / error…"
            value={q()}
            onInput={(value): void => {
              setQ(value);
              load();
            }}
          />
          <Select
            id="status-filter"
            onChange={(ev): void => {
              setStatus(ev.currentTarget.value);
              load();
            }}
          >
            <option value="">all statuses</option>
            {STATUS_FAMILIES.map((family) => (
              <option value={family}>{family}</option>
            ))}
          </Select>
          <input
            type="text"
            class={`${FIELD_BOX} w-28`}
            placeholder="min ms"
            value={minMs()}
            onChange={(ev): void => {
              setMinMs((ev.target as HTMLInputElement).value);
              load();
            }}
          />
        </Toolbar>

        <Card pad={false}>
          <DataTable
            label="History"
            columns={HEADERS}
            rows={rowsList()}
            rowKey={(r): string => r.id}
            render={rowCells}
            onRowClick={(r): void => navigate("detail", r.id)}
            align={[4, 5]}
            loading={!loaded() && rowsList().length === 0}
            empty={
              <EmptyState
                icon="database"
                message="No persisted traces in the window."
                hint="Traces are archived to SQLite as they complete."
              />
            }
          />
        </Card>
      </Show>

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
