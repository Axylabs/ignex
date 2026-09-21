/**
 * @fileoverview Logs view — structured observatory log stream on the page
 * primitives: `PageHeader` (title/description plus refresh/clear actions and the
 * Live/Archive source toggle) → `StatRow` → `Toolbar` (level + text filters) →
 * `DataTable` → states. Live tail via the `logs` domain; module-scoped signals
 * keep the window, stats and filters across view remounts.
 */

import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  onCleanup,
  Show,
  untrack,
} from "solid-js";

import { clearLogs, getLogs } from "../api";
import { LevelBadge } from "../components/badge";
import { Button } from "../components/button";
import { Card } from "../components/card";
import { SearchInput, Select } from "../components/fields";
import { Icon } from "../components/icon";
import { mergeById } from "../components/keyed";
import { PageHeader, Toolbar } from "../components/page";
import { EmptyState, ErrorState } from "../components/states";
import { Stat, StatRow } from "../components/stats";
import { DataTable } from "../components/table";
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

/** Table column labels, in `DataTable` render order. */
const HEADERS = ["When", "Level", "Source", "Message", "Trace"];

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
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [loaded, setLoaded] = createSignal(false);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  onCleanup((): void => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
  });

  const load = (): void => {
    void getLogs({
      q: untrack(q) || undefined,
      level: untrack(level) || undefined,
      persisted: untrack(persisted),
      limit: 300,
    })
      .then((res): void => {
        setLoadError(null);
        setRecords((prev) => mergeById(prev, res.records as LogRow[], (r) => String(r.id)));
        setStats(res.stats);
        setLoaded(true);
      })
      .catch((err: Error): void => {
        setRecords(new Map());
        setLoadError(err.message);
        setLoaded(true);
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

  /**
   * One `DataTable` row, one node per column (the primitive wraps each in a
   * `<td>`). The message cell keeps a hard max-width + `title` so long lines
   * truncate instead of silently clipping, with the original link preserved as
   * an `<a>` (the shell's delegated copy listener never fires on it).
   */
  const rowCells = (row: LogRow): JSX.Element[] => [
    <span class="text-muted" title={timeHM(row.ts)}>
      {timeAgo(row.ts)}
    </span>,
    <LevelBadge level={row.level} />,
    <span class="text-muted">{row.source}</span>,
    <span class="block max-w-[640px] truncate font-mono" title={row.message}>
      {row.message}
      {row.attrs !== null && row.attrs !== undefined ? (
        <span class="ml-2 text-faint">{JSON.stringify(row.attrs)}</span>
      ) : null}
    </span>,
    row.traceId !== null ? (
      <a
        class="inline-flex items-center gap-1 text-accent hover:underline"
        href={`#/requests/${encodeURIComponent(row.traceId ?? "")}/waterfall`}
        onClick={(ev): void => {
          ev.preventDefault();
          ev.stopPropagation();
          navigate("detail", row.traceId ?? "", "waterfall");
        }}
      >
        request
        <Icon name="external-link" size={12} />
      </a>
    ) : (
      <span class="text-faint">—</span>
    ),
  ];

  return (
    <div class="flex flex-col gap-4">
      <PageHeader
        title="Logs"
        description="Structured log stream — newest first, last 300"
        actions={
          <>
            <Button
              size="sm"
              ariaPressed={!persisted()}
              label="Live"
              onClick={(): void => {
                setPersisted(false);
                load();
              }}
            />
            <Button
              size="sm"
              ariaPressed={persisted()}
              label="Archive"
              onClick={(): void => {
                setPersisted(true);
                load();
              }}
            />
            <Button icon="refresh" label="Refresh" onClick={(): void => load()} />
            <Button
              variant="danger"
              icon="trash"
              label="Clear"
              onClick={(): void => {
                void clearLogs().then((): void => {
                  toast("log ring cleared");
                  load();
                });
              }}
            />
          </>
        }
      />

      <StatRow>
        <Stat
          value={fmtNum(recordsList().length)}
          label="logs (window)"
          sub={persisted() ? "from SQLite history" : "live ring"}
        />
        <Stat
          value={fmtNum(stats()?.warn ?? 0)}
          label="warns"
          tone={(stats()?.warn ?? 0) > 0 ? "warn" : undefined}
        />
        <Stat
          value={fmtNum(stats()?.error ?? 0)}
          label="errors"
          tone={(stats()?.error ?? 0) > 0 ? "err" : undefined}
        />
      </StatRow>

      <Toolbar>
        <SearchInput
          id="search"
          placeholder="filter messages…"
          value={q()}
          onInput={(value): void => {
            setQ(value);
            if (debounceTimer !== null) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(load, 250);
          }}
        />
        <Select
          id="level-filter"
          onChange={(ev): void => {
            setLevel(ev.currentTarget.value);
            load();
          }}
        >
          <option value="">all levels</option>
          <option value="debug">debug+</option>
          <option value="info">info+</option>
          <option value="warn">warn+</option>
          <option value="error">error only</option>
        </Select>
      </Toolbar>

      <Card pad={false}>
        <DataTable
          label="Logs"
          columns={HEADERS}
          rows={recordsList()}
          rowKey={(row): string => String(row.id)}
          render={rowCells}
          onRowClick={(row): void => navigate("logDetail", String(row.id))}
          loading={!loaded() && recordsList().length === 0}
          empty={
            <EmptyState
              icon="file-text"
              message="No logs captured yet."
              hint='Call ctx.debug.log("warn", "…") or debugLog() anywhere, or just console.log — it is mirrored here.'
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
