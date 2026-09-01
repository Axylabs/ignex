/**
 * @fileoverview AI view — the agent-facing summary: headline cards, recent
 * errors drill-down and the MCP connect snippet.
 */

import { type Component, createSignal, type JSX, Show } from "solid-js";

import type { AiDebugSummary } from "../../types";
import { BASE, getAiSummary } from "../api";
import {
  Chip,
  MethodPill,
  Panel,
  rowKeyHandler,
  StatCard,
  StatRow,
  StatusPill,
} from "../components/widgets";
import { fmtNum, timeAgo } from "../format";
import { navigate } from "../router";
import { copyAttr } from "./copy-attr";

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
              <StatCard value={fmtNum(s.traces.total)} label="traces" sub="ring buffer" />
              <StatCard
                value={fmtNum(s.traces.errors)}
                label="errors"
                tone={s.traces.errors > 0 ? "err" : undefined}
              />
              <StatCard value={fmtNum(s.traces.p95DurationMs)} label="p95 ms" sub="duration" />
              <StatCard
                value={fmtNum(s.events.total)}
                label="events"
                sub={s.events.enabled ? (s.events.connected ? "connected" : "offline") : "n/a"}
                tone={s.events.errors > 0 ? "err" : undefined}
              />
              <StatCard value={fmtNum(s.clients.length)} label="clients" sub="published" />
              <StatCard value={fmtNum(s.routes)} label="routes" sub="known" />
            </StatRow>
            <Show when={s.traces.recentErrors !== undefined && s.traces.recentErrors.length > 0}>
              <Panel title="Recent errors (drill-down target)">
                <table>
                  <thead>
                    <tr>
                      {["When", "Method", "Path", "Status", "Error"].map((l) => (
                        <th>{l}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(s.traces.recentErrors ?? []).map(
                      (e): JSX.Element => (
                        <tr
                          tabIndex={0}
                          onClick={(): void => navigate("detail", e.id)}
                          onKeyDown={rowKeyHandler((): void => navigate("detail", e.id))}
                        >
                          <td class="text-muted">{timeAgo(e.ts)}</td>
                          <td>
                            <MethodPill method={e.method} />
                          </td>
                          <td class="font-mono">{e.path}</td>
                          <td>
                            <StatusPill status={e.status} />
                          </td>
                          <td class="text-muted">{e.error}</td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </Panel>
            </Show>
            <Panel
              title="Connect an AI agent (MCP)"
              headExtra={
                <button type="button" class="ghost mini" {...copyAttr(mcpConfig)}>
                  copy config
                </button>
              }
            >
              <div>
                <p class="hint">
                  Point any MCP client (Claude Desktop, Cursor, VS Code) at the @ignex/mcp server
                  with these env vars. The agent can then read this summary, list/read/replay
                  requests, inspect NATS events and publish probes — no context dump needed.
                </p>
                <pre class="replay">{mcpConfig}</pre>
                <div class="client-tags">
                  {MCP_TOOLS.map((tool) => (
                    <Chip>{tool}</Chip>
                  ))}
                </div>
              </div>
            </Panel>
          </>
        );
      }}
    </Show>
  );
};
