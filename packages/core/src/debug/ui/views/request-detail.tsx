/**
 * @fileoverview Request detail view — `PageHeader` (back + `METHOD /path` +
 * status badge + actions) → identity summary strip → ARIA `Tabs` → panels.
 * Serves BOTH live-ring traces and persisted history traces: live is tried
 * first, then history (deep links keep working after restarts).
 */

import { type Component, createSignal, For, type JSX, Match, Show, Switch } from "solid-js";

import { getHistoryDetail, getRequestDetail, replayRequest } from "../api";
import { Badge, Chip, KindBadge, MethodBadge, StatusBadge } from "../components/badge";
import { Button } from "../components/button";
import { Card } from "../components/card";
import { BodyPanel, QueriesTable, TimeBreakdown, Waterfall } from "../components/detail-parts";
import { headerRows, Kvs, type KvsRow } from "../components/kvs";
import { PageHeader } from "../components/page";
import { EmptyState, ErrorState, LoadingState } from "../components/states";
import { Stat, StatRow, type StatTone } from "../components/stats";
import { Tabs } from "../components/tabs";
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

/** Stat tone for a duration (shares the `durClass` thresholds). */
const durTone = (ms: number): StatTone => durClass(ms).replace("text-", "") as StatTone;

/** Tabs visible for a trace — Error only appears when the trace carries one. */
const visibleTabs = (t: DetailTrace): Array<{ id: string; label: string }> =>
  TABS.filter(([key]) => key !== "error" || Boolean(t.error)).map(([id, label]) => ({
    id,
    label,
  }));

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
        class="origin-chain cursor-copy text-faint"
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
      <span class="text-faint">
        {`${key}=${props.attrValue((kid.attrs as Record<string, unknown>)[key])}`}
      </span>,
    );
  }
  const isRoot = (kid.parentId ?? 0) === 0 && props.depth === 0;
  return (
    <>
      <div
        class={isRoot ? "node root" : "node"}
        style={{ "padding-left": `calc(var(--tree-indent) * ${props.depth})` }}
      >
        <span class={durClass(kid.durationMs)}>{fmtMs(kid.durationMs)}</span>
        {" · "}
        <b>{kid.name}</b> <KindBadge kind={kid.kind} />
        {kid.error ? <Badge tone="err">{kid.error}</Badge> : null}
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
    <Card title="Span tree">
      <div class="tree">
        <For each={byParent.get(0) ?? []}>
          {(kid): JSX.Element => (
            <SpanNode span={kid} depth={0} byParent={byParent} attrValue={attrValue} />
          )}
        </For>
      </div>
    </Card>
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

/** Identity strip under the header — method/status/id/ip/time/source chips. */
const DetailSummary = (props: { t: DetailTrace }): JSX.Element => (
  <div class="flex flex-wrap items-center gap-2">
    <MethodBadge method={props.t.method} />
    <StatusBadge status={props.t.status} />
    <Chip class="font-mono" title="request id" dataCopy={props.t.requestId}>
      {props.t.requestId}
    </Chip>
    <Chip class="font-mono" title="client ip">
      {props.t.ip}
    </Chip>
    <Chip class="font-mono" title="started">
      {timeHM(props.t.ts)}
    </Chip>
    <Show when={props.t.sourceFile}>
      {(source): JSX.Element => (
        <Chip class="font-mono" title="source">
          {source()}
        </Chip>
      )}
    </Show>
  </div>
);

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
          <Card title="Request headers">
            <Kvs rows={headerRows(t.request.headers)} />
          </Card>
          <Card title="Response headers">
            <Kvs rows={headerRows(t.responseHeaders ?? {})} />
          </Card>
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
        <Card>
          <EmptyState
            icon="refresh"
            message="Press “Replay” above to re-issue this exact request through the server."
          />
        </Card>
      );

    // Overview and Error share the overview layout.
    const errorText = `${t.error ?? ""}${t.errorStack ? `\n\n${t.errorStack}` : ""}`;
    return (
      <>
        <StatRow>
          <Stat value={fmtMs(t.durationMs)} label="total" tone={durTone(t.durationMs)} />
          <Stat value={String(t.dbCount)} label="db queries" sub={fmtMs(t.dbTimeMs)} />
          <Stat value={String(t.spans.length)} label="spans" />
          <Stat value={t.route ?? "—"} label="route" />
        </StatRow>
        {active === "error" && t.error ? (
          <Card
            title="Error"
            actions={<Button size="sm" icon="copy" label="Copy" dataCopy={errorText} />}
          >
            <pre class="err-stack">{errorText}</pre>
          </Card>
        ) : null}
        {t.stages !== undefined && t.stages.length > 0 ? (
          <Card title="Lifecycle stages">
            <div class="flex flex-wrap gap-1.5">
              {t.stages.map((s) => (
                <Chip>{s}</Chip>
              ))}
            </div>
          </Card>
        ) : null}
        <TimeBreakdown spans={t.spans} durationMs={t.durationMs} />
        <SpanTree spans={t.spans} />
        <Card title="Request">
          <Kvs rows={requestKvsRows(t)} />
        </Card>
      </>
    );
  };

  return (
    <Switch>
      <Match when={trace()} keyed>
        {(t): JSX.Element => {
          const curl = t.curl ?? `curl -i -X ${t.method} '${t.request.url}'`;
          const description = `${t.requestId} · ${t.ip} · ${timeHM(t.ts)}${
            t.sourceFile ? ` · ${t.sourceFile}` : ""
          }`;
          return (
            <div class="flex flex-col gap-4">
              <PageHeader
                back={(): void => window.history.back()}
                title={`${t.method} ${t.path}`}
                badge={<StatusBadge status={t.status} />}
                description={description}
                actions={
                  <>
                    <Button icon="copy" label="Copy curl" dataCopy={curl} />
                    <Button
                      variant="primary"
                      icon="refresh"
                      label="Replay"
                      onClick={(): void => {
                        toast("replaying…");
                        void replayRequest(t.id).then((res): void => {
                          if (res.error !== undefined && res.error !== null) {
                            toast(`replay failed: ${res.error}`);
                            return;
                          }
                          toast(`replay ${res.status ?? ""} in ${fmtMs(res.durationMs ?? null)}`);
                        });
                      }}
                    />
                  </>
                }
              />
              <DetailSummary t={t} />
              <div>
                <Tabs
                  tabs={visibleTabs(t)}
                  active={tab()}
                  onSelect={(next): void => {
                    setTab(next);
                    navigate("detail", t.id, next);
                  }}
                />
                {/* Keyed on the tab so only the body swaps when the tab moves. */}
                <div
                  id={`tabpanel-${tab()}`}
                  role="tabpanel"
                  aria-labelledby={`tab-${tab()}`}
                  class="flex flex-col gap-4 pt-4"
                >
                  <Show when={tab()} keyed>
                    {(active): JSX.Element => tabContent(t, active)}
                  </Show>
                </div>
              </div>
            </div>
          );
        }}
      </Match>
      <Match when={loadError()} keyed>
        {(msg): JSX.Element => (
          <div class="flex flex-col gap-4">
            <PageHeader back={(): void => window.history.back()} title="Request not found" />
            <ErrorState message={msg} hint="Is the debugbar enabled and the server running?" />
          </div>
        )}
      </Match>
      {/* Loading: trace + error both still pending. */}
      <Match when={true}>
        <LoadingState rows={5} />
      </Match>
    </Switch>
  );
};
