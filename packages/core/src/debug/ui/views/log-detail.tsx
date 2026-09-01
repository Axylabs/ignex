/**
 * @fileoverview Log detail view — one full record with request correlation.
 */

import { type Component, createSignal, type JSX, Match, Switch } from "solid-js";

import { getLogDetail } from "../api";
import { EmptyState, Kvs, LevelPill, Panel } from "../components/widgets";
import { timeHM } from "../format";
import { currentRoute, navigate } from "../router";
import { copyAttr } from "./copy-attr";

/** The log-detail surface for the id in the current route. */
export const LogDetailView: Component = () => {
  const route = currentRoute();
  const id = Number(route.id ?? "0");
  const [record, setRecord] = createSignal<{
    id: number;
    ts: number;
    level: string;
    source: string;
    message: string;
    attrs?: Record<string, unknown> | null;
    traceId: string | null;
    requestId: string | null;
    route: string | null;
  } | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);

  void getLogDetail(id)
    .then((r): void => {
      setRecord(r as never);
    })
    .catch((err: Error): void => {
      setLoadError(err.message);
    });

  return (
    <Switch>
      <Match when={record()} keyed>
        {(r): JSX.Element => (
          <>
            <div class="summary">
              <button type="button" class="ghost mini" onClick={(): void => navigate("logs")}>
                ← back to logs
              </button>
              <LevelPill level={r.level} />
              <span class="pill kind" style={{ "--kc": "var(--k-lifecycle)" }}>
                {r.source}
              </span>
              <span class="meta">{`#${String(r.id)} · ${timeHM(r.ts)}`}</span>
              {r.traceId !== null ? (
                <button
                  type="button"
                  class="primary mini"
                  onClick={(): void => navigate("detail", r.traceId ?? "", "waterfall")}
                >
                  open request ↗
                </button>
              ) : null}
            </div>
            <Panel title="Record">
              <Kvs
                rows={(
                  [
                    ["id", `#${String(r.id)}`],
                    ["level", r.level],
                    ["source", r.source],
                    ["time", timeHM(r.ts)],
                    ["route", r.route ?? "—"],
                    ["request id", r.requestId ?? "—"],
                    ["trace", r.traceId ?? "—"],
                  ] as Array<[string, string]>
                ).map(([key, value]) => ({ k: key, v: value }))}
              />
            </Panel>
            <Panel title="Message">
              <pre class="stack whitespace-pre-wrap">{r.message}</pre>
            </Panel>
            {r.attrs !== null && r.attrs !== undefined && Object.keys(r.attrs).length > 0 ? (
              <Panel
                title="Structured fields"
                headExtra={
                  <button
                    type="button"
                    class="ghost mini"
                    {...copyAttr(JSON.stringify(r.attrs, null, 2))}
                  >
                    copy
                  </button>
                }
              >
                <pre class="stack">{JSON.stringify(r.attrs, null, 2)}</pre>
              </Panel>
            ) : null}
            {r.traceId === null ? (
              <Panel>
                <EmptyState
                  glyph="🔗"
                  message="No request correlation."
                  hint="The line was emitted outside any traced request — only records written inside a request carry its trace id."
                />
              </Panel>
            ) : null}
          </>
        )}
      </Match>
      <Match when={loadError()} keyed>
        {(msg): JSX.Element => (
          <>
            <div class="summary">
              <button type="button" class="ghost mini" onClick={(): void => navigate("logs")}>
                ← back to logs
              </button>
            </div>
            <Panel>
              <EmptyState
                glyph="🗒"
                message={msg}
                hint="Live-ring records rotate out as new lines arrive."
              />
            </Panel>
          </>
        )}
      </Match>
      {/* Loading: record + error both still pending. */}
      <Match when={true}>
        <div class="panel skeleton h-[120px]" />
      </Match>
    </Switch>
  );
};
