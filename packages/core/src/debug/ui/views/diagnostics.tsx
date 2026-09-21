/**
 * @fileoverview Diagnostics view — leak/trend verdict as a `Callout`, one card
 * per finding (severity `Badge`, detail, evidence `Kvs`, recommendation
 * `Callout`) and the force-GC header action. The report fetch and the GC
 * result handling are unchanged.
 */

import { type Component, createSignal, type JSX, Show } from "solid-js";

import { getDiagnostics, runGc } from "../api";
import { Badge, type BadgeTone, Chip } from "../components/badge";
import { Button } from "../components/button";
import { Callout, type CalloutTone, Card } from "../components/card";
import { Kvs } from "../components/kvs";
import { PageHeader } from "../components/page";
import { EmptyState } from "../components/states";
import { Stat, StatRow } from "../components/stats";
import { fmtNum } from "../format";

/** Finding severity → callout/badge tone. */
const SEVERITY_TONE: Record<"info" | "warning" | "critical", BadgeTone> = {
  info: "info",
  warning: "warn",
  critical: "err",
};

/** Verdict → callout tone. */
const VERDICT_TONE: Record<"ok" | "warning" | "critical", CalloutTone> = {
  ok: "ok",
  warning: "warn",
  critical: "err",
};

/** One finding card: severity badge + title + evidence + recommendation. */
const FindingCard = (props: {
  f: Awaited<ReturnType<typeof getDiagnostics>>["findings"][number];
}): JSX.Element => {
  const f = props.f;
  return (
    <Card
      title={f.title}
      actions={
        <>
          <Badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge>
          <Chip class="font-mono">{f.id}</Chip>
        </>
      }
    >
      <div class="text-sm text-ink">{f.detail}</div>
      <div class="mt-2.5">
        <Kvs
          rows={Object.keys(f.evidence).map((key) => ({
            k: key,
            v: String((f.evidence as Record<string, unknown>)[key]),
            mono: true,
          }))}
        />
      </div>
      <div class="mt-2.5">
        <Callout tone="info" title="Recommendation">
          {f.recommendation}
        </Callout>
      </div>
    </Card>
  );
};

/** The diagnostics panel. */
export const DiagnosticsView: Component = () => {
  const [report, setReport] = createSignal<Awaited<ReturnType<typeof getDiagnostics>> | null>(null);
  const [gcResult, setGcResult] = createSignal<string | null>(null);
  const [gcRunning, setGcRunning] = createSignal(false);

  const load = (): void => {
    void getDiagnostics()
      .then(setReport)
      .catch((): void => {});
  };

  load();

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
    <div class="flex flex-col gap-4">
      <PageHeader
        title="Diagnostics"
        description="Leak/trend verdict from the observatory analyzer."
        actions={
          <>
            <Button
              variant="primary"
              icon="bolt"
              label="run full GC"
              disabled={gcRunning()}
              onClick={runGcNow}
            />
            <Button icon="refresh" label="Refresh" onClick={load} />
          </>
        }
      />
      <Show when={report()} keyed>
        {(d): JSX.Element => {
          const tr = d.trend;
          const label =
            d.verdict === "ok"
              ? "No anomalies detected"
              : d.verdict === "warning"
                ? "Warnings detected"
                : "Critical anomalies detected";
          return (
            <>
              <Callout tone={VERDICT_TONE[d.verdict]} title={label}>
                {`window ${String(d.windowMin)} min · ${String(d.samplesAnalyzed)} samples analyzed${
                  d.persist?.enabled === true
                    ? ` · SQLite persisting to ${d.persist.path ?? ""}`
                    : " · persistence off"
                }`}
              </Callout>
              <StatRow>
                <Stat
                  value={tr.heapMiBPerMin.toFixed(1)}
                  label="heap MiB/min"
                  sub="trend slope"
                  tone={Math.abs(tr.heapMiBPerMin) > 1 ? "err" : undefined}
                />
                <Stat value={tr.heapR2.toFixed(2)} label="trend R²" sub=">0.6 = real trend" />
                <Stat
                  value={`${tr.heapNowMiB.toFixed(1)} MiB`}
                  label="heap now"
                  sub={`min ${String(tr.heapMinMiB)} · max ${String(tr.heapMaxMiB)}`}
                />
                <Stat
                  value={`${tr.eventLoopP95Ms.toFixed(1)} ms`}
                  label="loop delay p95"
                  sub="window"
                  tone={tr.eventLoopP95Ms > 50 ? "warn" : undefined}
                />
                <Stat
                  value={fmtNum(tr.activeRequestsMax)}
                  label="peak active"
                  sub="in-flight requests"
                />
              </StatRow>
              {d.findings.length === 0 ? (
                <Card>
                  <EmptyState
                    icon="check"
                    message="Nothing suspicious. Memory flat, loop responsive, requests draining."
                    hint="Findings appear automatically as trends emerge — check back after load tests or long soak runs."
                  />
                </Card>
              ) : (
                d.findings.map((f) => <FindingCard f={f} />)
              )}
              <Card title="Actions">
                <p class="text-sm text-muted">
                  A full GC forces a collection so you can separate cache growth from real leaks
                  (heap should drop back toward its floor).
                </p>
                <Show when={gcResult() !== null}>
                  <div class="mt-2 font-mono text-sm text-muted">{gcResult() ?? ""}</div>
                </Show>
              </Card>
            </>
          );
        }}
      </Show>
    </div>
  );
};
