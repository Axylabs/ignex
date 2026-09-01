/**
 * @fileoverview Request-detail sub-renderers: waterfall rows with idle-gap
 * analysis, time breakdown, the database queries table (sent/result
 * expandables), body panels and the nested span tree. Shared by the detail
 * view; kept pure: data in, JSX out.
 */

import { createMemo, For, type JSX, Show } from "solid-js";

import { durClass, fmtMs, kindColor, looksLikeJson, prettyJson } from "../format";
import { copyAttr } from "../views/copy-attr";
import type { SpanLike } from "../views/detail-types";
import { EmptyState, KindPill, Kvs, type KvsRow, Panel } from "./widgets";

const pctOf = (ms: number, total: number): number => Math.max((ms / total) * 100, 0.3);

/* ── time breakdown ─────────────────────────────────────────────────────── */

/**
 * Time breakdown: per-kind totals + unaccounted gap analysis (union of span
 * intervals subtracted from the total).
 */
export function TimeBreakdown(props: { spans: SpanLike[]; durationMs: number }): JSX.Element {
  const total = Math.max(props.durationMs, 1);
  const data = createMemo(() => {
    const by = new Map<string, { ms: number; count: number }>();
    const intervals: Array<[number, number]> = [];
    for (const s of props.spans) {
      if (s.id === 0) continue; // root == request itself — would hide gaps
      const entry = by.get(s.kind) ?? { ms: 0, count: 0 };
      entry.ms += s.durationMs;
      entry.count += 1;
      by.set(s.kind, entry);
      intervals.push([s.startMs, s.startMs + Math.max(s.durationMs, 0)]);
    }
    intervals.sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let cursor = 0;
    for (const [start, end] of intervals) {
      if (end <= cursor) continue;
      covered += end - Math.max(start, cursor);
      if (end > cursor) cursor = end;
    }
    const unaccounted = Math.max(total - covered, 0);
    const keys = [...by.keys()].sort((a, z) => (by.get(z)?.ms ?? 0) - (by.get(a)?.ms ?? 0));
    const rows = keys.map((name) => ({
      name,
      ms: by.get(name)?.ms ?? 0,
      count: by.get(name)?.count ?? 0,
    }));
    rows.sort((a, z) => z.ms - a.ms);
    if (unaccounted > 0.05) rows.push({ name: "unaccounted", ms: unaccounted, count: 0 });
    return { keys, by, unaccounted, rows };
  });

  return (
    <Panel
      title="Time breakdown"
      hint={<span class="hint">{`where the ${fmtMs(total)} went`}</span>}
    >
      <div class="stack">
        <For each={data().keys}>
          {(kind): JSX.Element => {
            const st = data().by.get(kind);
            if (st === undefined) return null;
            return (
              <span
                class="seg"
                style={{ width: `${pctOf(st.ms, total).toFixed(2)}%`, background: kindColor(kind) }}
                title={`${kind} ${st.ms.toFixed(2)} ms`}
              />
            );
          }}
        </For>
        <Show when={data().unaccounted > 0.05}>
          <span
            class="seg unacc"
            style={{ width: `${pctOf(data().unaccounted, total).toFixed(2)}%` }}
            title={`unaccounted ${data().unaccounted.toFixed(2)} ms`}
          />
        </Show>
      </div>
      <div>
        <For each={data().rows}>
          {(row): JSX.Element => (
            <div class="bd-row">
              <span
                class="dot"
                style={{
                  background: row.name === "unaccounted" ? "var(--faint)" : kindColor(row.name),
                }}
              />
              <span class="name">{row.name}</span>
              <span class="count">{row.count > 0 ? `${row.count}×` : "gap"}</span>
              <span class={`ms ${durClass(row.ms)}`}>{fmtMs(row.ms)}</span>
              <span class="pct">{((row.ms / total) * 100).toFixed(1)}%</span>
            </div>
          )}
        </For>
      </div>
    </Panel>
  );
}

/* ── waterfall ──────────────────────────────────────────────────────────── */

const WF_KINDS = ["db", "cache", "http", "render", "auth", "lifecycle", "custom", "error"];

/** Bytes of a string (UTF-8 aware via TextEncoder). */
const byteSize = (text: string): number => new TextEncoder().encode(text).length;

/** Compact byte formatting ("12.3 KiB"). */
const fmtBytes = (n: number): string => (n > 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`);

/** Shorten long text for summary cells. */
const shorten = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** First line of a multi-line value (origin chains), unchanged when single. */
const firstLine = (text: string): string => text.split("\n")[0] ?? text;

/** Pretty-print a JSON-looking string; pass through otherwise. */
const prettyJsonStr = (text: string): string => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

type WfEntry =
  | { type: "gap"; left: number; width: number; ms: number }
  | { type: "span"; span: SpanLike; left: number; width: number };

/** Key/value rows for one span's expandable detail. */
const spanKvRows = (s: SpanLike): KvsRow[] => {
  const rows: KvsRow[] = [
    { k: "span", v: s.name },
    { k: "kind", v: s.kind },
    { k: "start", v: `${s.startMs.toFixed(2)} ms` },
    { k: "duration", v: fmtMs(s.durationMs), mono: true },
  ];
  if (s.open === true) rows.push({ k: "state", v: "left open" });
  if (s.error) rows.push({ k: "error", v: s.error });
  if (s.origin) {
    rows.push({
      k: "origin",
      v: (
        <span class="copyable" title="click to copy origin" {...copyAttr(s.origin)}>
          {s.origin}
        </span>
      ),
    });
  }
  for (const key of Object.keys(s.attrs ?? {})) {
    const val = (s.attrs as Record<string, unknown>)[key];
    if (val !== null && typeof val === "object") {
      rows.push({
        k: key,
        v: <pre class="mini">{JSON.stringify(val, null, 2)}</pre>,
      });
    } else {
      rows.push({ k: key, v: String(val) });
    }
  }
  return rows;
};

/** One expandable waterfall row (the bar row is the `<summary>`). */
const WfSpanRow = (props: { span: SpanLike; left: number; width: number }): JSX.Element => {
  const s = props.span;
  const hint = `${s.kind} · start ${s.startMs.toFixed(1)}ms · dur ${s.durationMs.toFixed(2)}ms${
    s.error ? ` · ${s.error}` : ""
  }`;
  return (
    <details class="wf-item">
      <summary class="wf-row" title={hint}>
        <div class="wf-label">
          <KindPill kind={s.kind} /> {`${s.open === true ? "⏳ " : s.error ? "✕ " : ""}${s.name}`}
        </div>
        <div class="wf-track">
          <div
            class="wf-bar"
            style={{
              left: `${props.left.toFixed(2)}%`,
              width: `${props.width.toFixed(2)}%`,
              background: kindColor(s.kind),
            }}
          />
        </div>
      </summary>
      <div class="wf-detail">
        <Kvs rows={spanKvRows(s)} />
      </div>
    </details>
  );
};

/**
 * Waterfall: spans sorted by start time with idle/unaccounted gap rows
 * between them; each span row expands into its full kv detail.
 */
export function Waterfall(props: { spans: SpanLike[]; total: number }): JSX.Element {
  const rows = createMemo((): WfEntry[] => {
    const sorted = [...props.spans].sort((a, b) => a.startMs - b.startMs);
    const out: WfEntry[] = [];
    let prevEnd = 0;
    for (const s of sorted) {
      if (s.id === 0) continue; // root row is redundant — the ruler shows total
      const end = s.startMs + s.durationMs;
      if (s.startMs > prevEnd + 0.05) {
        out.push({
          type: "gap",
          left: (prevEnd / props.total) * 100,
          width: Math.max(((s.startMs - prevEnd) / props.total) * 100, 0.2),
          ms: s.startMs - prevEnd,
        });
      }
      out.push({
        type: "span",
        span: s,
        left: (s.startMs / props.total) * 100,
        width: Math.max((s.durationMs / props.total) * 100, 0.35),
      });
      if (end > prevEnd) prevEnd = end;
    }
    return out;
  });

  return (
    <Panel title="Waterfall">
      <div class="wf-legend">
        {WF_KINDS.map((kind) => (
          <span>
            <i class="dot" style={{ background: kindColor(kind) }} />
            {kind}
          </span>
        ))}
      </div>
      <div class="wf-ruler">
        <span>0 ms</span>
        <span>{Math.round(props.total / 2)} ms</span>
        <span>{Math.round(props.total)} ms</span>
      </div>
      <div class="wf">
        <For each={rows()}>
          {(entry): JSX.Element =>
            entry.type === "gap" ? (
              <div class="wf-row wf-gap" title={`idle / unaccounted ${entry.ms.toFixed(2)} ms`}>
                <div class="wf-label">
                  <span class="text-faint">…idle</span>
                </div>
                <div class="wf-track">
                  <div
                    class="wf-bar gap"
                    style={{
                      left: `${entry.left.toFixed(2)}%`,
                      width: `${entry.width.toFixed(2)}%`,
                    }}
                  />
                </div>
              </div>
            ) : (
              <WfSpanRow span={entry.span} left={entry.left} width={entry.width} />
            )
          }
        </For>
      </div>
    </Panel>
  );
}

/* ── database queries table ─────────────────────────────────────────────── */

/** One query row: sent params + result preview expandables. */
const QueryRow = (props: { q: SpanLike; index: number; nested: boolean }): JSX.Element => {
  const attrs = (props.q.attrs ?? {}) as Record<string, unknown>;
  const sentRaw = attrs.params !== undefined ? attrs.params : attrs.sent;

  const sentCell = (): JSX.Element => {
    if (sentRaw === undefined || sentRaw === null) {
      return <span class="text-muted">—</span>;
    }
    const full = typeof sentRaw === "string" ? sentRaw : JSON.stringify(sentRaw);
    return (
      <details class="q-sent">
        <summary class="font-mono text-muted">{shorten(full, 60)}</summary>
        <pre class="mini">{prettyJsonStr(full)}</pre>
      </details>
    );
  };

  const resultCell = createMemo((): JSX.Element => {
    const q = props.q;
    if (q.error) {
      return <span class="pill status err">{q.error}</span>;
    }
    const bits: string[] = [];
    if (attrs.rowCount !== undefined) bits.push(`${String(attrs.rowCount)} rows`);
    if (attrs.changes !== undefined) bits.push(`${String(attrs.changes)} changed`);
    if (attrs.reply !== undefined && attrs.rowCount === undefined && attrs.changes === undefined)
      bits.push("reply");
    if (bits.length === 0 && (attrs.preview !== undefined || attrs.reply !== undefined))
      bits.push("ok");
    const previewText =
      attrs.preview !== undefined
        ? String(attrs.preview)
        : attrs.reply !== undefined
          ? String(attrs.reply)
          : undefined;
    return (
      <>
        <span class="font-mono text-ok">{bits.join(" · ")}</span>
        {previewText !== undefined ? (
          <details class="q-sent">
            <summary class="font-mono text-muted">{shorten(previewText, 60)}</summary>
            <pre class="mini">{prettyJsonStr(previewText)}</pre>
          </details>
        ) : null}
      </>
    );
  });

  return (
    <tr>
      <td class="text-right font-mono">{String(props.index + 1)}</td>
      <td class={`font-mono ${durClass(props.q.durationMs)}`}>{fmtMs(props.q.durationMs)}</td>
      <td class="font-mono wrap" style={props.nested ? { "padding-left": "22px" } : undefined}>
        {props.nested ? <span class="text-faint">↳ </span> : null}
        {props.q.name}
      </td>
      <td class="wrap">
        <div class="q-json">{sentCell()}</div>
      </td>
      <td class="wrap">
        <div class="q-json">{resultCell()}</div>
      </td>
      <td class="wrap text-muted">
        {props.q.origin ? (
          <details class="q-sent">
            <summary
              class="font-mono text-muted"
              title="click to copy origin"
              {...copyAttr(props.q.origin)}
            >
              {firstLine(props.q.origin)}
            </summary>
            <pre class="mini">{props.q.origin}</pre>
          </details>
        ) : (
          ""
        )}
      </td>
    </tr>
  );
};

/** Database queries table with sent/params + result expandables. */
export function QueriesTable(props: { spans: SpanLike[] }): JSX.Element {
  const queries = props.spans.filter((s) => s.kind === "db");
  if (queries.length === 0) {
    return (
      <Panel>
        <EmptyState
          glyph="🗄"
          message="No database queries recorded."
          hint="Wrap DB calls in ctx.debug.query(sql, params, fn) or debugQuery() — timing, params and results are captured automatically."
        />
      </Panel>
    );
  }
  const totalMs = queries.reduce((acc, q) => acc + q.durationMs, 0);
  const byId = new Map<number, SpanLike>();
  for (const sp of props.spans) byId.set(sp.id, sp);

  return (
    <Panel
      title={`Database (${queries.length} · ${fmtMs(totalMs)})`}
      hint={
        <span class="hint">
          sent = what went to the db · result = what came back · ↳ = wire round-trip inside the op
          above
        </span>
      }
    >
      <table>
        <thead>
          <tr>
            {["#", "Duration", "Query", "Sent", "Result", "Origin"].map((label) => (
              <th>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <For each={queries}>
            {(q, i): JSX.Element => {
              const parent =
                q.parentId !== null && q.parentId !== undefined ? byId.get(q.parentId) : undefined;
              return (
                <QueryRow q={q} index={i()} nested={parent !== undefined && parent.kind === "db"} />
              );
            }}
          </For>
        </tbody>
      </table>
    </Panel>
  );
}

/* ── body viewer ────────────────────────────────────────────────────────── */

/** Body viewer panel (pretty JSON when applicable + copy button). */
export function BodyPanel(props: {
  title: string;
  bodyText: string | null;
  contentType: string | null;
  truncated: boolean;
  meta: string;
}): JSX.Element {
  const isJson =
    (props.contentType ?? "").toLowerCase().includes("json") || looksLikeJson(props.bodyText);
  return (
    <div class="panel">
      <div class="panel-head">
        <h2>{props.title}</h2>
        <span class="hint font-mono">
          {`${props.contentType ?? "content-type unknown"}${
            props.bodyText ? ` · ${fmtBytes(byteSize(props.bodyText))}` : ""
          } · ${props.meta}`}
        </span>
        <span class="grow" />
        {props.bodyText ? (
          <button type="button" class="ghost mini" {...copyAttr(props.bodyText)}>
            copy
          </button>
        ) : null}
      </div>
      {props.bodyText === null || props.bodyText === "" ? (
        <EmptyState
          glyph="📄"
          message={`${props.title} was not captured.`}
          hint="Bodies capture when debugbar({ captureBody: true }) — the default in debug mode. Streams (SSE), binary and >1 MiB responses are skipped by design."
        />
      ) : (
        <>
          <pre class={`body${isJson ? " json" : ""}`}>{prettyJson(props.bodyText)}</pre>
          {props.truncated ? (
            <div class="muted hint px-3 py-1.5">
              ⚠ truncated at the capture cap — the full payload reached the client.
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
