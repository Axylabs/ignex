/**
 * @fileoverview AI view — the agent-facing summary: `PageHeader` → `StatRow`
 * (traces / events / clients / routes) → the recent-errors `DataTable`
 * (drill-down target) → the MCP connect `Card` with the copyable config snippet
 * and the tool list as chips. One `getAiSummary()` fetch on mount drives the
 * whole view; the fetch, the keyed `Show` and every displayed value are
 * unchanged.
 */

import { type Component, createSignal, type JSX, Show } from "solid-js";

import type { AiDebugSummary } from "../../types";
import { BASE, getAiSummary } from "../api";
import { Chip, MethodBadge, StatusBadge } from "../components/badge";
import { Button } from "../components/button";
import { Card } from "../components/card";
import { PageHeader } from "../components/page";
import { Stat, StatRow } from "../components/stats";
import { DataTable } from "../components/table";
import { fmtNum, timeAgo } from "../format";
import { navigate } from "../router";

const MCP_TOOLS = [
  "debug-summary",
  "debug-requests",
  "debug-request",
  "debug-replay",
  "debug-logs",
  "debug-metrics",
  "debug-diagnostics",
  "debug-state",
  "debug-history",
  "debug-events",
  "debug-event-publish",
  "debug-system",
  "debug-kt",
] as const;

/** The AI panel. */
export const AiView: Component = () => {
  const [summary, setSummary] = createSignal<AiDebugSummary | null>(null);
  void getAiSummary()
    .then(setSummary)
    .catch((): void => {});

  return (
    <div class="flex flex-col gap-4">
      <PageHeader
        title="AI"
        description="Agent-facing snapshot: trace and event counts, recent errors and the MCP connect snippet."
      />
      <Show when={summary()} keyed>
        {(s): JSX.Element => {
          const base = BASE.replace(/\/$/, "");
          const mcpConfig = JSON.stringify(
            {
              mcpServers: {
                "ignex-debug": {
                  command: "bunx",
                  args: ["@ignex/mcp"],
                  env: {
                    IGNEX_DEBUGBAR_URL: `${window.location.origin}${base}`,
                    IGNEX_DEBUGBAR_TOKEN:
                      new URLSearchParams(window.location.search).get("token") ?? "",
                  },
                },
              },
            },
            null,
            2,
          );
          return (
            <>
              <StatRow>
                <Stat value={fmtNum(s.traces.total)} label="traces" sub="ring buffer" />
                <Stat
                  value={fmtNum(s.traces.errors)}
                  label="errors"
                  tone={s.traces.errors > 0 ? "err" : undefined}
                />
                <Stat value={fmtNum(s.traces.p95DurationMs)} label="p95 ms" sub="duration" />
                <Stat
                  value={fmtNum(s.events.total)}
                  label="events"
                  sub={s.events.enabled ? (s.events.connected ? "connected" : "offline") : "n/a"}
                  tone={s.events.errors > 0 ? "err" : undefined}
                />
                <Stat value={fmtNum(s.clients.length)} label="clients" sub="published" />
                <Stat value={fmtNum(s.routes)} label="routes" sub="known" />
              </StatRow>
              <Show when={s.traces.recentErrors !== undefined && s.traces.recentErrors.length > 0}>
                <Card pad={false} title="Recent errors (drill-down target)">
                  <DataTable
                    label="Recent errors"
                    columns={["When", "Method", "Path", "Status", "Error"]}
                    rows={s.traces.recentErrors ?? []}
                    rowKey={(e): string => e.id}
                    align={[3]}
                    render={(e): JSX.Element[] => [
                      <span class="text-muted">{timeAgo(e.ts)}</span>,
                      <MethodBadge method={e.method} />,
                      <span class="font-mono">{e.path}</span>,
                      <StatusBadge status={e.status} />,
                      <span class="block max-w-[360px] truncate text-muted" title={e.error}>
                        {e.error}
                      </span>,
                    ]}
                    onRowClick={(e): void => navigate("detail", e.id)}
                  />
                </Card>
              </Show>
              <Card
                title="Connect an AI agent (MCP)"
                headExtra={
                  <Button size="sm" icon="copy" label="copy config" dataCopy={mcpConfig} />
                }
              >
                <div>
                  <p class="mb-2 text-xs text-muted">
                    Point any MCP client (Claude Desktop, Cursor, VS Code) at the @ignex/mcp server
                    with these env vars. The agent can then read this summary, list/read/replay
                    requests, inspect NATS events and publish probes — no context dump needed.
                  </p>
                  <pre class="overflow-auto rounded-md border border-line bg-surface-3 p-2.5 font-mono text-xs text-ink">
                    {mcpConfig}
                  </pre>
                  <div class="mt-3 flex flex-wrap gap-1.5">
                    {MCP_TOOLS.map((tool) => (
                      <Chip class="font-mono">{tool}</Chip>
                    ))}
                  </div>
                </div>
              </Card>
            </>
          );
        }}
      </Show>
    </div>
  );
};
