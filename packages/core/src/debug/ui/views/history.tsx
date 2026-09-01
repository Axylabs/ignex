/**
 * @fileoverview History view — persisted traces from the SQLite observatory
 * (cross-restart), with status/min-ms/error filters and deep links into the
 * request detail (history source is resolved by fallback there).
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

import { getHistory, getMeta, type HistoryList } from "../api";
import { mergeById } from "../components/keyed";
import {
  EmptyState,
  MethodPill,
  Panel,
  rowKeyHandler,
  StatCard,
  StatRow,
  StatusPill,
} from "../components/widgets";
import { durClass, fmtMs, fmtNum, timeAgo, timeHM } from "../format";
import { navigate } from "../router";

/** The history panel. */
export const HistoryView: Component = () => {
  const [rows, setRows] = createSignal<Map<string, HistoryList["rows"][number]>>(new Map());
  const [q, setQ] = createSignal("");
  const [status, setStatus] = createSignal("");
  const [minMs, setMinMs] = createSignal("");
  const [unavailable, setUnavailable] = createSignal(false);

  const load = (): void => {
    void getHistory({
      q: untrack(q) || undefined,
      status: untrack(status) || undefined,
      minMs: untrack(minMs) || undefined,
      errorsOnly: false,
      limit: 200,
    })
      .then((res): void => {
        setRows((prev) => mergeById(prev, res.rows ?? [], (r) => r.id));
      })
      .catch((): void => {
        setRows(new Map());
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

  return (
    <Show
      when={!unavailable()}
      fallback={
        <Panel>
          <EmptyState
            glyph="🗄"
            message="Persisted history unavailable."
            hint="Enable persistence with debugbar({ persist: true }) (default on in debug mode) and make sure bun:sqlite is available. Everything recorded from then on lands in .ignex/observatory.db and survives restarts."
          />
        </Panel>
      }
    >
      <div>
        <StatRow>
          <StatCard value={fmtNum(rowsList().length)} label="history rows" sub="newest first" />
          <StatCard
            value={fmtNum(errs())}
            label="with errors"
            tone={errs() > 0 ? "err" : undefined}
          />
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
                load();
              }}
            />
            <select
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
            <input
              class="search max-w-[110px]"
              type="text"
              placeholder="min ms"
              value={minMs()}
              onChange={(ev): void => {
                setMinMs((ev.target as HTMLInputElement).value);
                load();
              }}
            />
            <span class="grow" />
            <button type="button" class="ghost mini" onClick={(): void => load()}>
              ↻ refresh
            </button>
          </div>
        </Panel>
        <Panel>
          <table>
            <thead>
              <tr>
                {["When", "Method", "Path", "Status", "Duration", "DB", "Error"].map((l) => (
                  <th>{l}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <For each={rowsList()}>
                {(r): JSX.Element => (
                  <tr
                    onClick={(): void => navigate("detail", r.id)}
                    onKeyDown={rowKeyHandler((): void => navigate("detail", r.id))}
                    title={timeHM(r.ts)}
                    tabIndex={0}
                  >
                    <td class="text-muted" title={timeHM(r.ts)}>
                      {timeAgo(r.ts)}
                    </td>
                    <td>
                      <MethodPill method={r.method} />
                    </td>
                    <td class="font-mono">{r.path}</td>
                    <td>
                      <StatusPill status={r.status} />
                    </td>
                    <td class={`font-mono ${durClass(r.durationMs)}`}>{fmtMs(r.durationMs)}</td>
                    <td class="font-mono text-muted">
                      {r.dbCount > 0 ? `${String(r.dbCount)}q · ${fmtMs(r.dbTimeMs)}` : "—"}
                    </td>
                    <td class="text-muted">
                      {r.error !== null ? <span class="pill status err">{r.error}</span> : "—"}
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Panel>
      </div>
    </Show>
  );
};
