/**
 * @fileoverview Log detail view — `PageHeader` (back + `LevelBadge` + request
 * correlation action) over Record / Message / Structured-fields cards. The
 * record fetch and the not-found path are unchanged; only the presentation
 * moved onto the page primitives.
 */

import { type Component, createSignal, type JSX, Match, Switch } from "solid-js";

import { getLogDetail } from "../api";
import { LevelBadge } from "../components/badge";
import { Button } from "../components/button";
import { Card } from "../components/card";
import { Kvs } from "../components/kvs";
import { PageHeader } from "../components/page";
import { EmptyState, ErrorState, LoadingState } from "../components/states";
import { timeHM } from "../format";
import { currentRoute, navigate } from "../router";

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
          <div class="flex flex-col gap-4">
            <PageHeader
              back={(): void => navigate("logs")}
              title={`Log #${String(r.id)}`}
              badge={<LevelBadge level={r.level} />}
              description={`${r.source} · ${timeHM(r.ts)}`}
              actions={
                r.traceId !== null ? (
                  <Button
                    variant="primary"
                    icon="arrow-right"
                    label="Open request"
                    onClick={(): void => navigate("detail", r.traceId ?? "", "waterfall")}
                  />
                ) : undefined
              }
            />
            <Card title="Record">
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
            </Card>
            <Card title="Message">
              <pre class="body">{r.message}</pre>
            </Card>
            {r.attrs !== null && r.attrs !== undefined && Object.keys(r.attrs).length > 0 ? (
              <Card
                title="Structured fields"
                actions={
                  <Button
                    size="sm"
                    icon="copy"
                    label="Copy"
                    dataCopy={JSON.stringify(r.attrs, null, 2)}
                  />
                }
              >
                <pre class="mini">{JSON.stringify(r.attrs, null, 2)}</pre>
              </Card>
            ) : null}
            {r.traceId === null ? (
              <Card>
                <EmptyState
                  icon="external-link"
                  message="No request correlation."
                  hint="The line was emitted outside any traced request — only records written inside a request carry its trace id."
                />
              </Card>
            ) : null}
          </div>
        )}
      </Match>
      <Match when={loadError()} keyed>
        {(msg): JSX.Element => (
          <div class="flex flex-col gap-4">
            <PageHeader back={(): void => navigate("logs")} title="Log record" />
            <ErrorState message={msg} hint="Live-ring records rotate out as new lines arrive." />
          </div>
        )}
      </Match>
      {/* Loading: record + error both still pending. */}
      <Match when={true}>
        <LoadingState rows={4} />
      </Match>
    </Switch>
  );
};
