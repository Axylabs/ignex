/**
 * @fileoverview State view — application/process snapshot: runtime facts,
 * feature flags, plugin inventory and env-var NAMES (values never exposed).
 * The `getState()` fetch and every displayed value are unchanged.
 */

import { type Component, createSignal, type JSX, Show } from "solid-js";

import { getState } from "../api";
import { Chip } from "../components/badge";
import { Card, Disclosure } from "../components/card";
import { Icon } from "../components/icon";
import { Kvs } from "../components/kvs";
import { PageHeader } from "../components/page";
import { Stat, StatRow } from "../components/stats";
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

/** Feature flag chip: icon + label, with the on/off state exposed to AT. */
const FeatureChip = (props: { on: boolean; label: string }): JSX.Element => (
  <Chip title={`${props.label}: ${props.on ? "on" : "off"}`}>
    <Icon
      name={props.on ? "check" : "x-circle"}
      size={12}
      class={props.on ? "text-ok" : "text-faint"}
    />
    <span class="sr-only">{props.on ? "enabled" : "disabled"}</span>
    {props.label}
  </Chip>
);

/** The state panel. */
export const StateView: Component = () => {
  const [snap, setSnap] = createSignal<StateSnapshot | null>(null);
  void (getState() as Promise<StateSnapshot>).then(setSnap).catch((): void => {});

  return (
    <div class="flex flex-col gap-4">
      <PageHeader
        title="State"
        description="Runtime facts, feature flags, plugins and env-var names (values are never exposed)."
      />
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
                <Stat value={rt.bunVersion} label="bun" sub={`${rt.platform}/${rt.arch}`} />
                <Stat
                  value={`${String(mem.rssMiB)} MiB`}
                  label="rss"
                  sub={`heap ${String(mem.heapUsedMiB)}/${String(mem.heapTotalMiB)}`}
                />
                <Stat
                  value={String(s.stores?.tracesRetained ?? 0)}
                  label="traces retained"
                  sub={`${String(s.stores?.activeRequests ?? 0)} active now`}
                />
                <Stat
                  value={String(s.routes ?? 0)}
                  label="routes"
                  sub={`${String((s.plugins ?? []).length)} plugins`}
                />
              </StatRow>
              <Card title="Runtime">
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
              </Card>
              <Card title="Features">
                <div class="flex flex-wrap gap-2">
                  <FeatureChip on={s.features?.logs ?? false} label="logs" />
                  <FeatureChip on={s.features?.metrics ?? false} label="metrics" />
                  <FeatureChip on={s.features?.persist ?? false} label="sqlite persist" />
                </div>
              </Card>
              <Card title="Plugins">
                <div class="flex flex-wrap gap-2">
                  {(s.plugins ?? []).map((p) => (
                    <Chip>{p}</Chip>
                  ))}
                </div>
              </Card>
              <Disclosure summary="Environment variable names" count={(s.envKeys ?? []).length}>
                <div class="flex flex-wrap gap-2">
                  {(s.envKeys ?? []).map((k) => (
                    <Chip class="font-mono">{k}</Chip>
                  ))}
                </div>
                <p class="mt-2 text-xs text-faint">
                  Names only — values are never exposed by the debugbar.
                </p>
              </Disclosure>
            </>
          );
        }}
      </Show>
    </div>
  );
};
