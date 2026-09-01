/**
 * @fileoverview Events view — NATS tracker panel: connection stats, recent
 * events with subject filtering, a publish composer and buffer clear.
 */

import { type Component, createMemo, createSignal, For, type JSX, Show } from "solid-js";

import { clearEvents, getEvents, publishEvent } from "../api";
import { DirPill, EmptyState, Panel, StatCard, StatRow } from "../components/widgets";
import { fmtNum, timeAgo, timeHM } from "../format";
import { toast } from "../toast";

interface EventRow {
  ts: number;
  direction: "in" | "out";
  subject: string;
  size: number;
  payload?: string;
  error?: string | null;
}

/** The NATS events panel. */
export const EventsView: Component = () => {
  const [enabled, setEnabled] = createSignal(true);
  const [hintText, setHint] = createSignal("");
  const [stats, setStats] = createSignal<Record<string, number> | null>(null);
  const [recent, setRecent] = createSignal<EventRow[]>([]);
  const [q, setQ] = createSignal("");
  const [subject, setSubject] = createSignal("");
  const [payload, setPayload] = createSignal('{"orderId":"ord_1"}');
  const [publishResult, setPublishResult] = createSignal("");

  const load = (): void => {
    void getEvents()
      .then((res): void => {
        setEnabled(res.enabled);
        setHint(res.hint ?? "");
        setStats(res.stats as unknown as Record<string, number>);
        setRecent(res.recent ?? []);
      })
      .catch((): void => {
        setEnabled(false);
      });
  };

  const publish = (): void => {
    const subj = subject().trim();
    if (subj === "") {
      setPublishResult("subject required");
      return;
    }
    let parsed: unknown = {};
    const rawPayload = payload().trim();
    if (rawPayload !== "") {
      try {
        parsed = JSON.parse(rawPayload);
      } catch {
        setPublishResult("payload is not valid JSON");
        return;
      }
    }
    setPublishResult("publishing…");
    void publishEvent(subj, parsed).then((res): void => {
      setPublishResult(res.ok ? "✔ published" : `✖ ${res.error ?? "failed"}`);
      load();
    });
  };

  const visible = createMemo(() => {
    const needle = q().toLowerCase();
    return recent().filter((ev) => needle === "" || ev.subject.toLowerCase().includes(needle));
  });

  load();

  return (
    <div>
      <Show when={stats()} keyed>
        {(st): JSX.Element => {
          const connected = Boolean(st.connected);
          return (
            <StatRow>
              <StatCard
                value={fmtNum(st.total)}
                label="events (window)"
                sub={connected ? `connected · ${String(st.url ?? "")}` : String(st.status ?? "")}
                tone={connected ? undefined : "warn"}
              />
              <StatCard value={fmtNum(st.out)} label="published" sub="outbound" />
              <StatCard value={fmtNum(st.in)} label="received" sub="inbound" />
              <StatCard
                value={fmtNum(st.errors ?? 0)}
                label="errors"
                tone={(st.errors ?? 0) > 0 ? "err" : undefined}
              />
              <StatCard value={fmtNum(st.bytes)} label="bytes" sub="payload size" />
            </StatRow>
          );
        }}
      </Show>

      <Panel title="Publish probe event">
        <div class="publish-composer">
          <input
            class="search font-mono"
            type="text"
            placeholder="subject, e.g. orders.created"
            spellcheck={false}
            value={subject()}
            onInput={(ev): void => {
              setSubject((ev.target as HTMLInputElement).value);
            }}
          />
          <textarea
            class="search font-mono"
            rows={3}
            placeholder='payload JSON, e.g. {"orderId":"ord_1"} — or leave empty'
            value={payload()}
            onInput={(ev): void => {
              setPayload((ev.target as HTMLTextAreaElement).value);
            }}
          />
          <button type="button" class="primary mini" onClick={publish}>
            ▶ publish
          </button>
          <span class="muted hint">{publishResult()}</span>
        </div>
      </Panel>

      <Panel>
        <div class="toolbar">
          <input
            class="search"
            id="search"
            type="text"
            placeholder="filter subject…"
            value={q()}
            onInput={(ev): void => {
              setQ((ev.target as HTMLInputElement).value);
            }}
          />
          <span class="grow" />
          <button type="button" class="ghost mini" onClick={(): void => load()}>
            ↻ refresh
          </button>
          <button
            type="button"
            class="ghost mini"
            onClick={(): void => {
              void clearEvents().then((): void => {
                toast("event buffer cleared");
                load();
              });
            }}
          >
            ✕ clear buffer
          </button>
        </div>
      </Panel>

      <Panel>
        <table>
          <thead>
            <tr>
              {["When", "Dir", "Subject", "Size", "Payload", "Error"].map((l) => (
                <th>{l}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <For each={visible()}>
              {(ev): JSX.Element => (
                <tr>
                  <td class="text-muted" title={timeHM(ev.ts)}>
                    {timeAgo(ev.ts)}
                  </td>
                  <td>
                    <DirPill direction={ev.direction} />
                  </td>
                  <td class="font-mono">{ev.subject}</td>
                  <td class="font-mono text-muted">{`${String(ev.size)} B`}</td>
                  <td class="font-mono text-muted">{ev.payload ?? ""}</td>
                  <td class="text-muted">
                    {ev.error ? <span class="pill status err">{ev.error}</span> : "—"}
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <Show when={!enabled()}>
          <EmptyState
            glyph="📡"
            message="NATS events not configured."
            hint={hintText() || undefined}
          />
        </Show>
      </Panel>
    </div>
  );
};
