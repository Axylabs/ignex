/**
 * @fileoverview DataTable primitive — a dense, scroll-contained table with a
 * sticky header. The table lives inside its own `overflow-auto` scroller, so
 * `thead th` sticks to the table's scroll box (not the viewport); numeric
 * columns listed in `align` are right-aligned and tabular.
 */

import { For, type JSX, Show } from "solid-js";

import { LoadingState } from "./states";

/** Keyboard activation for clickable rows (Enter/Space → action). */
export const rowKeyHandler =
  (action: () => void) =>
  (ev: KeyboardEvent): void => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      action();
    }
  };

interface DataTableProps<T> {
  /** Column header labels, in render order. */
  columns: string[];
  /** Rows to render. */
  rows: T[];
  /** Stable key for a row (emitted as `data-key`). */
  rowKey: (row: T) => string;
  /**
   * Row renderer: returns one node per column, in `columns` order. `DataTable`
   * wraps each node in a `<td>` so `align` can right-align numeric columns;
   * return a single node only for a single-column table.
   */
  render: (row: T) => JSX.Element;
  /** Makes rows clickable and keyboard-activatable (Enter/Space). */
  onRowClick?: ((row: T) => void) | undefined;
  /** Slot rendered in place of the body when there are no rows. */
  empty?: JSX.Element | undefined;
  /** Shows skeleton rows instead of data while the first fetch is in flight. */
  loading?: boolean | undefined;
  /** Column indices to right-align and render tabular. */
  align?: number[] | undefined;
  /** Row key of the selected row; emits `data-selected="true"` on its `<tr>`. */
  selectedKey?: string | undefined;
  /**
   * Optional per-row class hook; the returned value is appended to the row's
   * class list (e.g. `"row-fresh"` for a newly arrived row). Called once per
   * rendered row, so it may record the row in a seen-set.
   */
  rowClass?: ((row: T) => string | undefined) | undefined;
  /** Accessible name for the table. */
  label: string;
}

/**
 * Dense data table. `render` returns the cell nodes for one row; use
 * `onRowClick` to make a row navigable and `align` for numeric columns.
 */
export const DataTable = <T,>(props: DataTableProps<T>): JSX.Element => {
  const aligned = (index: number): boolean => props.align?.includes(index) === true;
  const cellList = (row: T): JSX.Element[] => {
    const raw = props.render(row);
    return Array.isArray(raw) ? raw : [raw];
  };
  const bodyClass = (index: number): string =>
    `px-2.5 py-1.5 align-top${aligned(index) ? " text-right tabular-nums" : ""}`;
  const rowClass = (): string =>
    `border-b border-line/60 focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2${
      props.onRowClick !== undefined ? " cursor-pointer hover:bg-surface-2" : ""
    } data-[selected=true]:shadow-[inset_2px_0_0_var(--accent)]`;
  const rowClassFor = (row: T): string => {
    const extra = props.rowClass?.(row);
    return extra !== undefined && extra !== "" ? `${rowClass()} ${extra}` : rowClass();
  };
  return (
    <div class="overflow-auto">
      <table class="w-full border-collapse text-sm" aria-label={props.label}>
        <thead>
          <tr>
            <For each={props.columns}>
              {(column, index) => (
                <th
                  scope="col"
                  class={`sticky top-0 z-10 border-b border-line bg-surface-2 px-2.5 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted${
                    aligned(index()) ? " text-right tabular-nums" : ""
                  }`}
                >
                  {column}
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <Show when={props.loading === true}>
            <tr>
              <td colspan={props.columns.length}>
                <LoadingState rows={5} />
              </td>
            </tr>
          </Show>
          <Show
            when={props.loading !== true && props.rows.length === 0 && props.empty !== undefined}
          >
            <tr>
              <td colspan={props.columns.length}>{props.empty}</td>
            </tr>
          </Show>
          <Show when={props.loading !== true && props.rows.length > 0}>
            <For each={props.rows}>
              {(row) => (
                <tr
                  data-key={props.rowKey(row)}
                  data-selected={
                    props.selectedKey !== undefined && props.rowKey(row) === props.selectedKey
                      ? "true"
                      : undefined
                  }
                  tabindex={props.onRowClick !== undefined ? 0 : undefined}
                  class={rowClassFor(row)}
                  onClick={
                    props.onRowClick !== undefined ? () => props.onRowClick?.(row) : undefined
                  }
                  onKeyDown={
                    props.onRowClick !== undefined
                      ? rowKeyHandler(() => props.onRowClick?.(row))
                      : undefined
                  }
                >
                  <For each={cellList(row)}>
                    {(cell, index) => <td class={bodyClass(index())}>{cell}</td>}
                  </For>
                </tr>
              )}
            </For>
          </Show>
        </tbody>
      </table>
    </div>
  );
};
