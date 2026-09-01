/**
 * @fileoverview Jobs view — durable job store panel (queued/running/completed/
 * failed cards + recent jobs). Requires `debugbar({ data: { jobs } })`.
 */

import { type Component, createSignal, For, type JSX, Show } from "solid-js";

import { getJobs, type JobsPanel } from "../api";
import { EmptyState, Panel, StatCard, StatRow } from "../components/widgets";
import { fmtNum } from "../format";

/** Status pill for a free-form job status string. */
const StatusPill = (props: { status: string }): JSX.Element => (
  <span
    class={`pill status ${/fail|error/i.test(props.status) ? "err" : /run/i.test(props.status) ? "warn" : "ok"}`}
  >
    {props.status}
  </span>
);

/** The jobs panel. */
export const JobsView: Component = () => {
  const [data, setData] = createSignal<JobsPanel | null>(null);
  void getJobs()
    .then(setData)
    .catch((): void => {});

  return (
    <Show when={data()} keyed>
      {(res): JSX.Element => {
        if (res.enabled === false) {
          return (
            <Panel>
              <EmptyState
                glyph="⚙"
                message="No job store wired."
                hint="Pass debugbar({ data: { jobs } }) to enable this panel."
              />
            </Panel>
          );
        }
        if (res.error !== undefined) {
          return (
            <Panel>
              <div class="empty">{res.error}</div>
            </Panel>
          );
        }
        const byStatus = res.byStatus ?? {};
        const recent = res.recent ?? [];
        return (
          <>
            <StatRow>
              <StatCard value={fmtNum(byStatus.queued ?? 0)} label="queued" />
              <StatCard
                value={fmtNum(byStatus.running ?? 0)}
                label="running"
                tone={(byStatus.running ?? 0) > 0 ? "accent" : undefined}
              />
              <StatCard value={fmtNum(byStatus.completed ?? 0)} label="completed" tone="ok" />
              <StatCard
                value={fmtNum(byStatus.failed ?? 0)}
                label="failed"
                tone={(byStatus.failed ?? 0) > 0 ? "err" : undefined}
              />
            </StatRow>
            <Panel title={`Recent jobs (${String(res.total ?? recent.length)})`}>
              <table>
                <thead>
                  <tr>
                    {["Name", "Status", "Run at"].map((l) => (
                      <th>{l}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <For each={recent}>
                    {(job): JSX.Element => (
                      <tr>
                        <td class="font-mono">{job.name}</td>
                        <td>
                          <StatusPill status={job.status} />
                        </td>
                        <td class="text-muted">{new Date(job.runAt).toISOString()}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
              {recent.length === 0 ? <div class="empty">No jobs yet.</div> : null}
            </Panel>
          </>
        );
      }}
    </Show>
  );
};
