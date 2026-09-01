/**
 * @fileoverview State view — application/process snapshot: runtime facts,
 * feature flags, plugin inventory and env-var NAMES (values never exposed).
 */

import { type Component, createSignal, type JSX, Show } from "solid-js";

import { getState } from "../api";
import { Kvs, Panel, StatCard, StatRow } from "../components/widgets";
import { timeHM } from "../format";

interface StateSnapshot {
  service?: string;
  version?: string;
  environment?: string;
  debugMode?: boolean;
  runtime?: {
    bunVersion: string;
    platform: string;
    arch: string;
    pid: number;
    nodeEnv: string;
    startedAt: number;
    uptimeSec: number;
  };
  memory?: { rssMiB: number; heapUsedMiB: number; heapTotalMiB: number };
  envKeys?: string[];
  routes?: number;
  plugins?: string[];
  stores?: { tracesRetained: number; logsRetained: number; activeRequests: number };
  features?: { logs?: boolean; metrics?: boolean; persist?: boolean };
}

/** The state panel. */
export const StateView: Component = () => {
  const [snap, setSnap] = createSignal<StateSnapshot | null>(null);
  void (getState() as Promise<StateSnapshot>).then(setSnap).catch((): void => {});

  return (
    <Show when={snap()} keyed>
      {(s): JSX.Element => {
        const rt = s.runtime ?? {
          bunVersion: "?",
          platform: "?",
          arch: "?",
          pid: 0,
          nodeEnv: "?",
          startedAt: 0,
          uptimeSec: 0,
        };
        const mem = s.memory ?? { rssMiB: 0, heapUsedMiB: 0, heapTotalMiB: 0 };
        return (
          <>
            <StatRow>
              <StatCard value={rt.bunVersion} label="bun" sub={`${rt.platform}/${rt.arch}`} />
              <StatCard
                value={`${String(mem.rssMiB)} MiB`}
                label="rss"
                sub={`heap ${String(mem.heapUsedMiB)}/${String(mem.heapTotalMiB)}`}
              />
              <StatCard
                value={String(s.stores?.tracesRetained ?? 0)}
                label="traces retained"
                sub={`${String(s.stores?.activeRequests ?? 0)} active now`}
              />
              <StatCard
                value={String(s.routes ?? 0)}
                label="routes"
                sub={`${String((s.plugins ?? []).length)} plugins`}
              />
            </StatRow>
            <Panel title="Runtime">
              <Kvs
                rows={(
                  [
                    ["service", `${s.service ?? "?"}@${s.version ?? "?"}`],
                    [
                      "environment",
                      `${s.environment ?? "?"}${s.debugMode === true ? " (debug ON)" : ""}`,
                    ],
                    ["pid", String(rt.pid)],
                    ["started", timeHM(rt.startedAt)],
                    ["uptime", `${String(rt.uptimeSec)}s`],
                    ["node env", rt.nodeEnv],
                  ] as Array<[string, string]>
                ).map(([key, value]) => ({ k: key, v: value }))}
              />
            </Panel>
            <Panel title="Features">
              <div class="client-tags">
                <span class="chip">{`${(s.features?.logs ?? false) ? "✔" : "✖"} logs`}</span>
                <span class="chip">{`${(s.features?.metrics ?? false) ? "✔" : "✖"} metrics`}</span>
                <span class="chip">{`${(s.features?.persist ?? false) ? "✔" : "✖"} sqlite persist`}</span>
              </div>
            </Panel>
            <Panel title="Plugins">
              <div class="client-tags">
                {(s.plugins ?? []).map((p) => (
                  <span class="chip">{p}</span>
                ))}
              </div>
            </Panel>
            <details class="panel px-4 py-3.5">
              <summary class="cursor-pointer">
                Environment variable names ({(s.envKeys ?? []).length})
              </summary>
              <div class="client-tags mt-2.5">
                {(s.envKeys ?? []).map((k) => (
                  <span class="chip font-mono">{k}</span>
                ))}
              </div>
              <p class="hint">Names only — values are never exposed by the debugbar.</p>
            </details>
          </>
        );
      }}
    </Show>
  );
};
