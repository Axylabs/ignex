/**
 * @fileoverview Key/value grid primitives — the definition grid used by the
 * detail views and diagnostics. Moved from `widgets.tsx`; the API is unchanged,
 * only the styling now comes from Tailwind utilities bound to the tokens.
 */

import { For, type JSX } from "solid-js";

/** One key/value row. */
export interface KvsRow {
  /** Row label. */
  k: string;
  /** Row value — text or a JSX node (e.g. a `<pre>`). */
  v: string | JSX.Element;
  /** Render the value in the mono face. */
  mono?: boolean;
}

/** Key/value definition grid. */
export const Kvs = (props: { rows: KvsRow[] }): JSX.Element => (
  <div class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
    <For each={props.rows}>
      {(row): JSX.Element => (
        <>
          <span class="text-xs uppercase tracking-wide text-faint">{row.k}</span>
          <span class={row.mono === true ? "font-mono text-ink" : "text-ink"}>{row.v}</span>
        </>
      )}
    </For>
  </div>
);

/** Header record → kvs rows. */
export const headerRows = (headers: Record<string, string>): KvsRow[] =>
  Object.keys(headers).map((key) => ({ k: key, v: headers[key] ?? "", mono: true }));
