/**
 * @fileoverview Request detail view — summary bar + tabs (Overview, Waterfall,
 * Queries, Headers, Body, Error, Replay). Serves BOTH live-ring traces and
 * persisted history traces: live is tried first, then history (deep links keep
 * working after restarts).
 */

import { type Component, createSignal, For, type JSX, Match, Show, Switch } from "solid-js";

import { getHistoryDetail, getRequestDetail, replayRequest } from "../api";
import { BodyPanel, QueriesTable, TimeBreakdown, Waterfall } from "../components/detail-parts";
import {
  EmptyState,
  headerRows,
  KindPill,
  Kvs,
  type KvsRow,
  MethodPill,
  Panel,
  StatCard,
  StatRow,
  StatusPill,
} from "../components/widgets";
import { durClass, fmtMs, headerValue, timeHM } from "../format";
import { currentRoute, navigate } from "../router";
import { toast } from "../toast";
import { copyAttr } from "./copy-attr";
import type { DetailTrace, SpanLike } from "./detail-types";

const TABS: Array<[string, string]> = [
  ["overview", "Overview"],
  ["waterfall", "Waterfall"],
  ["queries", "Queries"],
  ["headers", "Headers"],
  ["body", "Body"],
  ["error", "Error"],
  ["replay", "Replay"],
];

/** Fetch a trace by id: live ring first, persisted history as fallback. */
const fetchTrace = async (id: string): Promise<DetailTrace> => {
  try {
    return (await getRequestDetail(id)) as DetailTrace;
  } catch {
    return (await getHistoryDetail(id)) as DetailTrace;
  }
};

/* ── span tree (nested by parentId with origin/attrs meta lines) ────────── */

/** Cap on tree depth — guards against cyclic/malformed span data. */
const MAX_TREE_DEPTH = 64;

const SpanNode = (props: {
  span: SpanLike;
  depth: number;
  byParent: Map<number, SpanLike[]>;
  attrValue: (v: unknown) => string;
}): JSX.Element => {
  const kid = props.span;
  const meta: JSX.Element[] = [];
  if (kid.origin) {
    meta.push(
      <span
        class="origin-chain faint copyable"
        title="click to copy origin"
        {...copyAttr(kid.origin)}
      >
        {kid.origin}
      </span>,
    );
  }
  for (const key of Object.keys(kid.attrs ?? {})) {
    if (key === "params" || key === "error" || key === "stack") continue;
    meta.push(
      <span class="faint">
        {`${key}=${props.attrValue((kid.attrs as Record<string, unknown>)[key])}`}
      </span>,
    );
  }
  const isRoot = (kid.parentId ?? 0) === 0 && props.depth === 0;
  return (
    <>
      <div
        class={isRoot ? "node root" : "node"}
        style={{ "padding-left": `${props.depth * 14}px` }}
      >
        <span class={durClass(kid.durationMs)}>{fmtMs(kid.durationMs)}</span>
        {" · "}
        <b>{kid.name}</b> <KindPill kind={kid.kind} />
        {kid.error ? <span class="pill status err">{kid.error}</span> : null}
      </div>
      {meta.length > 0 ? <div class="tree-meta">{meta}</div> : null}
      {props.depth < MAX_TREE_DEPTH ? (
        <For each={props.byParent.get(kid.id) ?? []}>
          {(child): JSX.Element => (
            <SpanNode
              span={child}
              depth={props.depth + 1}
              byParent={props.byParent}
              attrValue={props.attrValue}
            />
          )}
        </For>
      ) : null}
    </>
  );
};

/** Span tree panel (children grouped by parentId, indented by depth). */
const SpanTree = (props: { spans: SpanLike[] }): JSX.Element => {
  const byParent = new Map<number, SpanLike[]>();
  for (const sp of props.spans) {
    // The request-root span (id 0) is redundant here — the tree starts at
    // its children; including it would make the root its own descendant and
    // recurse forever (it also carries no origin/attrs worth showing).
    if (sp.id === 0) continue;
    const parentKey = sp.parentId ?? 0;
    const list = byParent.get(parentKey) ?? [];
    list.push(sp);
    byParent.set(parentKey, list);
  }
  const attrValue = (v: unknown): string => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  };
  return (
    <Panel title="Span tree">
      <div class="tree">
        <For each={byParent.get(0) ?? []}>
          {(kid): JSX.Element => (
            <SpanNode span={kid} depth={0} byParent={byParent} attrValue={attrValue} />
          )}
        </For>
      </div>
    </Panel>
  );
};

/* ── detail view ────────────────────────────────────────────────────────── */

/** Request summary pairs (+ source pointer when the manifest knows it). */
const requestKvsRows = (t: DetailTrace): KvsRow[] => {
  const pairs: Array<[string, string]> = [
    ["requestId", String(t.requestId)],
    ["url", String(t.request.url)],
    ["route", String(t.route ?? "—")],
    ["client ip", String(t.ip)],
    ...(t.sourceFile ? [["source", t.sourceFile] as [string, string]] : []),
    ["started", timeHM(t.ts)],
    ["duration", fmtMs(t.durationMs)],
  ];
  return pairs.map(([key, value]) => ({ k: key, v: value }));
};

/** The detail surface for the id/tab in the current route. */
export const RequestDetailView: Component = () => {
  const route = currentRoute();
  const id = route.id ?? "";
  const [trace, setTrace] = createSignal<DetailTrace | null>(null);
  const [tab, setTab] = createSignal<string>(route.tab ?? "overview");
  const [loadError, setLoadError] = createSignal<string | null>(null);

  void fetchTrace(id)
    .then(setTrace)
    .catch((err: Error): void => {
      setLoadError(err.message);
    });

  /** Build the active tab's panels. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: view renderer — one branch per detail tab
  const tabContent = (t: DetailTrace, active: string): JSX.Element => {
    if (active === "waterfall")
      return (
        <>
          <TimeBreakdown spans={t.spans} durationMs={t.durationMs} />
          <Waterfall spans={t.spans} total={Math.max(t.durationMs, 1)} />
        </>
      );
    if (active === "queries") return <QueriesTable spans={t.spans} />;
    if (active === "headers")
      return (
        <>
          <Panel title="Request headers">
            <Kvs rows={headerRows(t.request.headers)} />
          </Panel>
          <Panel title="Response headers">
            <Kvs rows={headerRows(t.responseHeaders ?? {})} />
          </Panel>
        </>
      );
    if (active === "body")
      return (
        <>
          <BodyPanel
            title="Request body"
            bodyText={t.request.body ?? null}
            contentType={headerValue(t.request.headers, "content-type")}
            truncated={false}
            meta={`${t.method} ${t.path}`}
          />
          <BodyPanel
            title="Response body"
            bodyText={t.responseBody ?? null}
            contentType={headerValue(t.responseHeaders ?? {}, "content-type")}
            truncated={t.responseBodyTruncated === true}
            meta={`status ${t.status}`}
          />
        </>
      );
    if (active === "replay")
      return (
        <Panel>
          <EmptyState
            glyph="↻"
            message="Press “↻ replay” above to re-issue this exact request through the server."
          />
        </Panel>
      );

    // Overview and Error share the overview layout.
    return (
      <>
        <StatRow>
          <div class="stat accent">
            <div class={`v ${durClass(t.durationMs)}`}>{fmtMs(t.durationMs)}</div>
            <div class="k">total</div>
          </div>
          <StatCard value={String(t.dbCount)} label="db queries" sub={fmtMs(t.dbTimeMs)} />
          <StatCard value={String(t.spans.length)} label="spans" />
          <StatCard value={t.route ?? "—"} label="route" />
        </StatRow>
        {active === "error" && t.error ? (
          <Panel
            title="Error"
            headExtra={
              <button
                type="button"
                class="ghost mini"
                {...copyAttr(`${t.error}${t.errorStack ? `\n\n${t.errorStack}` : ""}`)}
              >
                copy
              </button>
            }
          >
            <pre class="err-stack">{`${t.error}${t.errorStack ? `\n\n${t.errorStack}` : ""}`}</pre>
          </Panel>
        ) : null}
        {t.stages !== undefined && t.stages.length > 0 ? (
          <Panel title="Lifecycle stages">
            <div class="flex flex-wrap gap-1.5">
              {t.stages.map((s) => (
                <span class="chip">{s}</span>
              ))}
            </div>
          </Panel>
        ) : null}
        <TimeBreakdown spans={t.spans} durationMs={t.durationMs} />
        <SpanTree spans={t.spans} />
        <Panel title="Request">
          <Kvs rows={requestKvsRows(t)} />
        </Panel>
      </>
    );
  };

  const summaryBar = (t: DetailTrace): JSX.Element => {
    const curl = t.curl ?? `curl -i -X ${t.method} '${t.request.url}'`;
    return (
      <div class="summary">
        <button type="button" class="ghost mini" onClick={(): void => window.history.back()}>
          ← back
        </button>
        <MethodPill method={t.method} />
        <span class="route-path">{t.path}</span>
        <StatusPill status={t.status} />
        <span class="meta">{`${t.requestId} · ${t.ip} · ${timeHM(t.ts)}`}</span>
        <span class="grow" />
        <button type="button" class="ghost mini" {...copyAttr(curl)}>
          ⧉ copy curl
        </button>
        <button
          type="button"
          class="primary mini"
          onClick={(): void => {
            toast("replaying…");
            void replayRequest(t.id).then((res): void => {
              if (res.error !== undefined && res.error !== null) {
                toast(`✖ ${res.error}`);
                return;
              }
              toast(`✔ replay ${res.status ?? ""} in ${fmtMs(res.durationMs ?? null)}`);
            });
          }}
        >
          ↻ replay
        </button>
      </div>
    );
  };

  const tabBar = (t: DetailTrace): JSX.Element => (
    <div class="tabs">
      {TABS.filter(([key]) => key !== "error" || Boolean(t.error)).map(([key, label]) => (
        <button
          type="button"
          data-tab={key}
          class={tab() === key ? "active" : ""}
          onClick={(): void => {
            setTab(key);
            navigate("detail", t.id, key);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <Switch>
      <Match when={trace()} keyed>
        {(t): JSX.Element => (
          <div>
            {summaryBar(t)}
            {tabBar(t)}
            {/* Keyed on the tab so only the body swaps when the tab moves. */}
            <Show when={tab()} keyed>
              {(active): JSX.Element => tabContent(t, active)}
            </Show>
          </div>
        )}
      </Match>
      <Match when={loadError()} keyed>
        {(msg): JSX.Element => (
          <Panel>
            <EmptyState
              glyph="⚠"
              message={msg}
              hint="Is the debugbar enabled and the server running?"
            />
          </Panel>
        )}
      </Match>
      {/* Loading: trace + error both still pending. */}
      <Match when={true}>
        <div class="panel skeleton h-[120px]" />
      </Match>
    </Switch>
  );
};
