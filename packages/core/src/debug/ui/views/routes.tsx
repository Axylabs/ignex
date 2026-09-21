/**
 * @fileoverview Routes view — the AOT manifest / live-router route inventory
 * with client-side filtering and copy-to-clipboard paths, on the page
 * primitives: `PageHeader` → `Toolbar` (search + count) → `DataTable` → states.
 */

import { type Component, createMemo, createSignal, type JSX, Show } from "solid-js";

import { getRoutes } from "../api";
import { MethodBadge } from "../components/badge";
import { Button } from "../components/button";
import { Card } from "../components/card";
import { SearchInput } from "../components/fields";
import { PageHeader, Toolbar } from "../components/page";
import { EmptyState, ErrorState } from "../components/states";
import { DataTable } from "../components/table";

/** One route-inventory row (`GET /api/routes`). */
interface RouteRow {
  method: string;
  path: string;
  file?: string;
}

/** Table column labels, in `DataTable` render order. */
const HEADERS = ["Method", "Path", "File", ""];

/** The routes panel. */
export const RoutesView: Component = () => {
  const [routes, setRoutes] = createSignal<RouteRow[]>([]);
  const [enabled, setEnabled] = createSignal(true);
  const [q, setQ] = createSignal("");
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [loaded, setLoaded] = createSignal(false);

  const load = (): void => {
    void getRoutes()
      .then((res): void => {
        setLoadError(null);
        setEnabled(res.enabled);
        setRoutes(res.routes ?? []);
        setLoaded(true);
      })
      .catch((err: Error): void => {
        setEnabled(false);
        setLoadError(err.message);
        setLoaded(true);
      });
  };

  load();

  const visible = createMemo(() => {
    const needle = q().toLowerCase();
    return routes().filter((r) => {
      if (needle === "") return true;
      return `${r.method} ${r.path} ${r.file ?? ""}`.toLowerCase().includes(needle);
    });
  });

  /**
   * One `DataTable` row, one node per column (the primitive wraps each in a
   * `<td>`). The method is a `MethodBadge`; the trailing cell keeps the
   * copyable `METHOD /path` via `dataCopy`.
   */
  const rowCells = (r: RouteRow): JSX.Element[] => [
    <MethodBadge method={r.method} />,
    <span class="font-mono">{r.path}</span>,
    <span class="text-muted">{r.file ?? ""}</span>,
    <Button
      variant="ghost"
      size="sm"
      icon="copy"
      label="Copy"
      title={`Copy ${r.method} ${r.path}`}
      dataCopy={`${r.method} ${r.path}`}
    />,
  ];

  return (
    <div class="flex flex-col gap-4">
      <PageHeader
        title="Routes"
        description="Generated route inventory — the source file name is the URL."
      />

      <Toolbar>
        <SearchInput
          id="search"
          placeholder="filter method / path / file…"
          value={q()}
          onInput={(value): void => {
            setQ(value);
          }}
        />
        <span class="ml-auto text-sm text-muted">{`${String(visible().length)} routes`}</span>
      </Toolbar>

      <Card pad={false}>
        <DataTable
          label="Routes"
          columns={HEADERS}
          rows={visible()}
          rowKey={(r): string => `${r.method} ${r.path}`}
          render={rowCells}
          loading={!loaded() && visible().length === 0}
          empty={
            <>
              <Show when={loadError() !== null}>
                <ErrorState
                  message={loadError() ?? ""}
                  hint="Is the debugbar enabled and the server running?"
                  onRetry={load}
                />
              </Show>
              <Show when={loadError() === null}>
                <EmptyState
                  icon="route"
                  message={enabled() ? "No matching routes." : "No route provider."}
                  hint={
                    enabled()
                      ? "Clear the filter to see the full inventory."
                      : "The KT page still lists routes from the manifest / router."
                  }
                />
              </Show>
            </>
          }
        />
      </Card>
    </div>
  );
};
