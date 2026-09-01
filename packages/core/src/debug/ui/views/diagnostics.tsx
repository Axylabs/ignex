/**
 * @fileoverview Diagnostics view — leak/trend verdict, findings with evidence
 * and the force-GC action.
 */

import { type Component, createSignal, type JSX, Show } from "solid-js";

import { getDiagnostics, runGc } from "../api";
import { EmptyState, Kvs, Panel, StatCard, StatRow } from "../components/widgets";
import { fmtNum } from "../format";

/** One finding card: severity pill + title + evidence + recommendation. */
const FindingCard = (props: {
  f: Awaited<ReturnType<typeof getDiagnostics>>["findings"][number];
}): JSX.Element => {
  const f = props.f;
  return (
    <Panel>
      <div class="f-head">
        <span class={`lv-pill sev-${f.severity}`}>{f.severity}</span>
        <span class="f-title">{f.title}</span>
        <span class="chip font-mono">{f.id}</span>
      </div>
      <div class="f-detail">{f.detail}</div>
      <div class="mt-2.5">
        <Kvs
          rows={Object.keys(f.evidence).map((key) => ({
            k: key,
            v: String((f.evidence as Record<string, unknown>)[key]),
            mono: true,
          }))}
        />
      </div>
      <div class="f-reco">{`→ ${f.recommendation}`}</div>
    </Panel>
  );
};

/** The diagnostics panel. */
export const DiagnosticsView: Component = () => {
  const [report, setReport] = createSignal<Awaited<ReturnType<typeof getDiagnostics>> | null>(null);
  const [gcResult, setGcResult] = createSignal<string | null>(null);
  const [gcRunning, setGcRunning] = createSignal(false);

  void getDiagnostics()
    .then(setReport)
    .catch((): void => {});

  const runGcNow = (): void => {
    setGcRunning(true);
    void runGc().then((res): void => {
      setGcResult(
        `GC ${res.supported ? "ran" : "unsupported here"}: heap ${String(res.beforeHeapUsedMiB)} → ${String(res.afterHeapUsedMiB)} MiB (freed ${String(res.freedMiB)} MiB)`,
      );
      setGcRunning(false);
    });
  };

  return (
    <Show when={report()} keyed>
      {(d): JSX.Element => {
        const tr = d.trend;
        const icon = d.verdict === "ok" ? "✔" : d.verdict === "warning" ? "⚠" : "✖";
        const label =
          d.verdict === "ok"
            ? "No anomalies detected"
            : d.verdict === "warning"
              ? "Warnings detected"
              : "Critical anomalies detected";
        return (
          <>
            <div class={`verdict ${d.verdict}`}>
              <span class="big">{icon}</span>
              <span>{label}</span>
              <span class="hint">
                {`window ${String(d.windowMin)} min · ${String(d.samplesAnalyzed)} samples analyzed${
                  d.persist?.enabled === true
                    ? ` · SQLite persisting to ${d.persist.path ?? ""}`
                    : " · persistence off"
                }`}
              </span>
            </div>
            <StatRow>
              <StatCard
                value={tr.heapMiBPerMin.toFixed(1)}
                label="heap MiB/min"
                sub="trend slope"
                tone={Math.abs(tr.heapMiBPerMin) > 1 ? "err" : undefined}
              />
              <StatCard value={tr.heapR2.toFixed(2)} label="trend R²" sub=">0.6 = real trend" />
              <StatCard
                value={`${tr.heapNowMiB.toFixed(1)} MiB`}
                label="heap now"
                sub={`min ${String(tr.heapMinMiB)} · max ${String(tr.heapMaxMiB)}`}
              />
              <StatCard
                value={`${tr.eventLoopP95Ms.toFixed(1)} ms`}
                label="loop delay p95"
                sub="window"
                tone={tr.eventLoopP95Ms > 50 ? "warn" : undefined}
              />
              <StatCard
                value={fmtNum(tr.activeRequestsMax)}
                label="peak active"
                sub="in-flight requests"
              />
            </StatRow>
            {d.findings.length === 0 ? (
              <Panel>
                <EmptyState
                  glyph="🧘"
                  message="Nothing suspicious. Memory flat, loop responsive, requests draining."
                  hint="Findings appear automatically as trends emerge — check back after load tests or long soak runs."
                />
              </Panel>
            ) : (
              d.findings.map((f) => <FindingCard f={f} />)
            )}
            <Panel title="Actions">
              <div>
                <button
                  type="button"
                  class="primary mini"
                  disabled={gcRunning()}
                  onClick={runGcNow}
                >
                  ♻ run full GC
                </button>
                <span class="muted hint">
                  {" "}
                  forces a collection so you can separate cache growth from real leaks (heap should
                  drop back toward its floor)
                </span>
                <div class="hint mt-2.5">{gcResult() ?? ""}</div>
              </div>
            </Panel>
          </>
        );
      }}
    </Show>
  );
};
