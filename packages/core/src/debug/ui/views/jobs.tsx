/**
 * @fileoverview Jobs view — durable job store panel on the page primitives:
 * `PageHeader` (title/description/refresh) → status `StatRow` → recent-jobs
 * `DataTable` → states. Requires `debugbar({ data: { jobs } })`; the
 * enabled/disabled/error branches are preserved.
 */

import { type Component, createSignal, type JSX, Show } from "solid-js";

import { getJobs, type JobsPanel } from "../api";
import { Badge, type BadgeTone } from "../components/badge";
import { Button } from "../components/button";
import { Card } from "../components/card";
import { PageHeader } from "../components/page";
import { EmptyState, ErrorState, LoadingState } from "../components/states";
import { Stat, StatRow } from "../components/stats";
import { DataTable } from "../components/table";
import { fmtNum } from "../format";

/** Table column labels, in `DataTable` render order. */
const HEADERS = ["Name", "Status", "Run at"];

/** One recent-jobs row (`GET /api/jobs`). */
type JobRow = NonNullable<JobsPanel["recent"]>[number];

/** Job status → badge tone (preserves the deleted local `StatusPill` mapping). */
const jobTone = (status: string): BadgeTone =>
  /fail|error/i.test(status) ? "err" : /run/i.test(status) ? "warn" : "ok";

/** The jobs panel. */
export const JobsView: Component = () => {
  const [data, setData] = createSignal<JobsPanel | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);

  const load = (): void => {
    void getJobs()
      .then((res): void => {
        setLoadError(null);
        setData(res);
      })
      .catch((err: Error): void => {
        setLoadError(err.message);
      });
  };

  load();

  /**
   * One `DataTable` row, one node per column (the primitive wraps each in a
   * `<td>`).
   */
  const rowCells = (job: JobRow): JSX.Element[] => [
    <span class="font-mono">{job.name}</span>,
    <Badge tone={jobTone(job.status)}>{job.status}</Badge>,
    <span class="text-muted">{new Date(job.runAt).toISOString()}</span>,
  ];

  return (
    <div class="flex flex-col gap-4">
      <PageHeader
        title="Jobs"
        description="Durable job store — queued, running, completed and failed"
        actions={<Button icon="refresh" label="Refresh" onClick={load} />}
      />

      <Show
        when={data()}
        keyed
        fallback={
          <Show when={loadError() === null}>
            <Card>
              <LoadingState rows={3} />
            </Card>
          </Show>
        }
      >
        {(res): JSX.Element => {
          if (res.enabled === false) {
            return (
              <Card>
                <EmptyState
                  icon="briefcase"
                  message="No job store wired."
                  hint="Pass debugbar({ data: { jobs } }) to enable this panel."
                />
              </Card>
            );
          }
          if (res.error !== undefined) {
            return <ErrorState message={res.error} onRetry={load} />;
          }
          const byStatus = res.byStatus ?? {};
          const recent = res.recent ?? [];
          return (
            <>
              <StatRow>
                <Stat value={fmtNum(byStatus.queued ?? 0)} label="queued" />
                <Stat
                  value={fmtNum(byStatus.running ?? 0)}
                  label="running"
                  tone={(byStatus.running ?? 0) > 0 ? "accent" : undefined}
                />
                <Stat value={fmtNum(byStatus.completed ?? 0)} label="completed" tone="ok" />
                <Stat
                  value={fmtNum(byStatus.failed ?? 0)}
                  label="failed"
                  tone={(byStatus.failed ?? 0) > 0 ? "err" : undefined}
                />
              </StatRow>
              <Card pad={false} title={`Recent jobs (${String(res.total ?? recent.length)})`}>
                <DataTable
                  label="Recent jobs"
                  columns={HEADERS}
                  rows={recent}
                  rowKey={(job): string => `${job.name}:${String(job.runAt)}`}
                  render={rowCells}
                  empty={<EmptyState icon="briefcase" message="No jobs yet." />}
                />
              </Card>
            </>
          );
        }}
      </Show>

      <Show when={loadError() !== null}>
        <ErrorState
          message={loadError() ?? ""}
          hint="Is the debugbar enabled and the server running?"
          onRetry={load}
        />
      </Show>
    </div>
  );
};
