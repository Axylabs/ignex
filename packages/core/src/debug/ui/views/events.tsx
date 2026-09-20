/**
 * @fileoverview Events view — the unified event buffer. Interleaves NATS
 * pub/sub rows (NatsEventTracker) and nova typed-realtime / WS trace rows so
 * you can see, side by side, what the app SENT (out) and RECEIVED (in), filter
 * by source/text, publish NATS probe events and clear the whole buffer. Built
 * from the page primitives: `PageHeader` → per-source `StatRow` → composer
 * `Card`s (`Field`/`SearchInput`/`Button`) → `Toolbar` → `DataTable` → states.
 */

import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Show,
} from "solid-js";

import type { DebugEventRow, DebugEventsPayload } from "../../types";
import { clearEvents, emitNovaEvent, getEvents, publishEvent } from "../api";
import { Badge, Chip, DirPill } from "../components/badge";
import { Button } from "../components/button";
import { Card } from "../components/card";
import { Field, SearchInput } from "../components/fields";
import { Icon } from "../components/icon";
import { PageHeader, Toolbar } from "../components/page";
import { EmptyState, ErrorState, LoadingState } from "../components/states";
import { Stat, StatRow, type StatTone } from "../components/stats";
import { DataTable } from "../components/table";
import { fmtNum, timeAgo, timeHM } from "../format";
import { baselineFrom, currentPulse, domainMoved, lastRevision } from "../live";
import { toast } from "../toast";

type SourceFilter = "all" | "nats" | "nova";

/** Table column labels, in `DataTable` render order. */
const HEADERS = ["When", "Dir", "Source", "Event", "Size", "Payload", "Error"];

/** Token-styled multiline box for JSON payloads (no `Textarea` primitive yet). */
const TEXTAREA_BOX =
  "min-h-16 w-full rounded-md border border-line bg-surface-3 px-2.5 py-2 font-mono text-md text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25";

/** One stat descriptor rendered in the per-source `StatRow`. */
interface StatDescriptor {
  key: string;
  value: number;
  label: string;
  sub?: string;
  tone?: StatTone;
}

/** Composer result tone — drives the inline status icon. */
type ResultTone = "ok" | "err" | "info";

/** A composer result line, replacing the old success/failure glyph prefix. */
interface ComposerResult {
  tone: ResultTone;
  text: string;
}

/** Inline composer status: icon + message, or nothing while idle. */
const ResultLine = (props: { result: ComposerResult | null }): JSX.Element => (
  <Show when={props.result !== null}>
    <span class="inline-flex items-center gap-1 text-xs text-muted" role="status">
      <Icon
        name={
          props.result?.tone === "ok"
            ? "check"
            : props.result?.tone === "err"
              ? "x-circle"
              : "clock"
        }
        class={
          props.result?.tone === "ok"
            ? "text-ok"
            : props.result?.tone === "err"
              ? "text-err"
              : "text-faint"
        }
      />
      {props.result?.text}
    </span>
  </Show>
);

/** Manual realtime (nova) event composer — fires via `POST /nova/events/emit`. */
const NovaEmitPanel = (props: { onEmitted: () => void }): JSX.Element => {
  const [name, setName] = createSignal("");
  const [target, setTarget] = createSignal("");
  const [body, setBody] = createSignal('{"ok":true}');
  const [result, setResult] = createSignal<ComposerResult | null>(null);

  const emit = (): void => {
    const evName = name().trim();
    if (evName === "") {
      setResult({ tone: "err", text: "event name required" });
      return;
    }
    let parsed: unknown = {};
    const raw = body().trim();
    if (raw !== "") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        setResult({ tone: "err", text: "payload is not valid JSON" });
        return;
      }
    }
    setResult({ tone: "info", text: "emitting…" });
    void emitNovaEvent(evName, parsed, target().trim())
      .then((res): void => {
        setResult(
          res.ok
            ? { tone: "ok", text: res.note ?? "emitted" }
            : { tone: "err", text: res.error ?? "failed" },
        );
        props.onEmitted();
      })
      .catch((err: Error): void => {
        setResult({ tone: "err", text: err.message });
      });
  };

  return (
    <Card title="Emit realtime event (nova)">
      <div class="flex flex-col gap-3">
        <Field label="Event">
          <SearchInput
            mono
            spellcheck={false}
            placeholder="event, e.g. recive-fe.created"
            value={name()}
            onInput={(value): void => {
              setName(value);
            }}
          />
        </Field>
        <Field label="Target">
          <SearchInput
            mono
            spellcheck={false}
            placeholder="target — user:u-42 · group:premium · topic:room · client:c-1 (blank = broadcast)"
            value={target()}
            onInput={(value): void => {
              setTarget(value);
            }}
          />
        </Field>
        <Field label="Payload">
          <textarea
            class={TEXTAREA_BOX}
            rows={3}
            placeholder='payload JSON, e.g. {"ok":true} — or leave empty'
            value={body()}
            onInput={(ev): void => {
              setBody((ev.target as HTMLTextAreaElement).value);
            }}
          />
        </Field>
        <div class="flex items-center gap-2">
          <Button variant="primary" label="Emit" onClick={emit} />
          <ResultLine result={result()} />
        </div>
      </div>
    </Card>
  );
};

/** The unified Events panel (NATS + nova/WS realtime). */
export const EventsView: Component = () => {
  const [data, setData] = createSignal<DebugEventsPayload | null>(null);
  const [loadError, setLoadError] = createSignal("");
  const [q, setQ] = createSignal("");
  const [source, setSource] = createSignal<SourceFilter>("all");
  const [subject, setSubject] = createSignal("");
  const [composer, setComposer] = createSignal('{"orderId":"ord_1"}');
  const [publishResult, setPublishResult] = createSignal<ComposerResult | null>(null);

  const load = (): void => {
    void getEvents(500)
      .then((res): void => {
        setLoadError("");
        setData(res);
      })
      .catch((err: Error): void => {
        setLoadError(err.message);
        setData(null);
      });
  };

  // Live tail: fetch once on mount, then refetch when the events domain moves
  // (NATS records bump it; nova rows ride along on every refetch + refresh).
  let mounted = false;
  const baseline = baselineFrom(lastRevision());
  createEffect((): void => {
    const pulse = currentPulse();
    if (!mounted) {
      mounted = true;
      load();
      return;
    }
    if (domainMoved(baseline, "events", pulse.rev)) load();
  });

  const nats = createMemo(() => data()?.sources.nats ?? null);
  const nova = createMemo(() => data()?.sources.nova ?? null);

  const cards = createMemo((): StatDescriptor[] => {
    const list: StatDescriptor[] = [];
    const n = nats();
    if (n !== null) {
      const connected = n.connected === true;
      list.push({
        key: "nats-total",
        value: n.size,
        label: "NATS events",
        sub: connected ? `connected · ${n.status ?? ""}` : (n.status ?? "not configured"),
        ...(connected ? {} : { tone: "warn" }),
      });
      list.push({ key: "nats-out", value: n.out, label: "published", sub: "outbound" });
      list.push({ key: "nats-in", value: n.in, label: "received", sub: "inbound" });
      list.push({
        key: "nats-errors",
        value: n.errors,
        label: "errors",
        ...(n.errors > 0 ? { tone: "err" } : {}),
      });
      list.push({ key: "nats-bytes", value: n.bytes, label: "bytes", sub: "payload size" });
    }
    const v = nova();
    if (v !== null) {
      list.push({ key: "nova-total", value: v.size, label: "Nova events", sub: "realtime ring" });
      list.push({ key: "nova-out", value: v.out, label: "sent", sub: "emit · publish" });
      list.push({
        key: "nova-in",
        value: v.in,
        label: "received",
        sub: "client · remote · bridge",
      });
      list.push({ key: "nova-bytes", value: v.bytes, label: "bytes", sub: "frame size" });
    }
    return list;
  });

  const publish = (): void => {
    const subj = subject().trim();
    if (subj === "") {
      setPublishResult({ tone: "err", text: "subject required" });
      return;
    }
    let parsed: unknown = {};
    const raw = composer().trim();
    if (raw !== "") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        setPublishResult({ tone: "err", text: "payload is not valid JSON" });
        return;
      }
    }
    setPublishResult({ tone: "info", text: "publishing…" });
    void publishEvent(subj, parsed)
      .then((res): void => {
        setPublishResult(
          res.ok ? { tone: "ok", text: "published" } : { tone: "err", text: res.error ?? "failed" },
        );
        load();
      })
      .catch((err: Error): void => {
        setPublishResult({ tone: "err", text: err.message });
      });
  };

  const visible = createMemo(() => {
    const rows = data()?.recent ?? [];
    const needle = q().trim().toLowerCase();
    const src = source();
    return rows.filter((ev) => {
      if (src !== "all" && ev.source !== src) return false;
      if (needle === "") return true;
      return (
        ev.name.toLowerCase().includes(needle) ||
        (ev.key ?? "").toLowerCase().includes(needle) ||
        ev.kind.toLowerCase().includes(needle)
      );
    });
  });

  const pick = (v: SourceFilter): void => {
    setSource(v);
  };

  const clear = (): void => {
    void clearEvents()
      .then((res): void => {
        toast(res.ok ? "event buffer cleared" : "clear failed");
        load();
      })
      .catch((err: Error): void => {
        toast(`clear failed: ${err.message}`);
      });
  };

  // Shown when the nova ring is not capturing payload previews yet.
  const captureHint =
    "payload previews off — enable novaPlugin({ trace: { capturePayloadChars: 400 } })";

  /**
   * One `DataTable` row, one node per column (the primitive wraps each in a
   * `<td>`); the direction keeps its in/out pill and the error cell truncates
   * via a `title`.
   */
  const rowCells = (ev: DebugEventRow): JSX.Element[] => [
    <span class="text-muted" title={timeHM(ev.ts)}>
      {timeAgo(ev.ts)}
    </span>,
    <DirPill direction={ev.direction} />,
    <Chip>{ev.source === "nova" ? "NOVA" : "NATS"}</Chip>,
    <span class="font-mono">
      {ev.name}
      <Show when={ev.key !== undefined && ev.key !== ""}>
        <span class="text-muted"> → {ev.key}</span>
      </Show>
    </span>,
    <span class="font-mono text-muted">{`${String(ev.size)} B`}</span>,
    <span class="font-mono text-muted" title={ev.payload}>
      {ev.payload !== "" ? ev.payload : "—"}
    </span>,
    <Show when={ev.error !== null} fallback={<span class="text-muted">—</span>}>
      <span title={ev.error ?? undefined}>
        <Badge tone="err">err</Badge>
      </span>
    </Show>,
  ];

  return (
    <div class="flex flex-col gap-4">
      <PageHeader
        title="Events"
        description="Unified NATS + nova realtime buffer — what the app sent (out) and received (in)"
        actions={
          <>
            <Button icon="refresh" label="Refresh" onClick={load} />
            <Button variant="danger" icon="trash" label="Clear buffer" onClick={clear} />
          </>
        }
      />

      <StatRow>
        <For each={cards()}>
          {(c): JSX.Element => (
            <Stat value={fmtNum(c.value)} label={c.label} sub={c.sub} tone={c.tone} />
          )}
        </For>
      </StatRow>

      <Show when={nova() !== null && nova()?.captures === false}>
        <p class="text-xs text-faint">{captureHint}</p>
      </Show>

      <Show when={nats() !== null}>
        <Card title="Publish NATS probe event">
          <div class="flex flex-col gap-3">
            <Field label="Subject">
              <SearchInput
                mono
                spellcheck={false}
                placeholder="subject, e.g. orders.created"
                value={subject()}
                onInput={(value): void => {
                  setSubject(value);
                }}
              />
            </Field>
            <Field label="Payload">
              <textarea
                class={TEXTAREA_BOX}
                rows={3}
                placeholder='payload JSON, e.g. {"orderId":"ord_1"} — or leave empty'
                value={composer()}
                onInput={(ev): void => {
                  setComposer((ev.target as HTMLTextAreaElement).value);
                }}
              />
            </Field>
            <div class="flex items-center gap-2">
              <Button variant="primary" label="Publish" onClick={publish} />
              <ResultLine result={publishResult()} />
            </div>
          </div>
        </Card>
      </Show>

      <Show when={nova() !== null}>
        <NovaEmitPanel onEmitted={load} />
      </Show>

      <Toolbar>
        <SearchInput
          id="search"
          placeholder="filter event / subject / target…"
          value={q()}
          onInput={(value): void => {
            setQ(value);
          }}
        />
        <Button
          size="sm"
          ariaPressed={source() === "all"}
          label="All"
          onClick={(): void => pick("all")}
        />
        <Button
          size="sm"
          ariaPressed={source() === "nats"}
          label="NATS"
          onClick={(): void => pick("nats")}
        />
        <Button
          size="sm"
          ariaPressed={source() === "nova"}
          label="Nova"
          onClick={(): void => pick("nova")}
        />
      </Toolbar>

      <Show when={loadError() !== ""}>
        <ErrorState message="Could not load events" hint={loadError()} onRetry={load} />
      </Show>
      <Show when={loadError() === ""}>
        <Show when={data() === null}>
          <Card>
            <LoadingState rows={5} />
          </Card>
        </Show>
        <Show when={data() !== null && data()?.enabled === false}>
          <Card>
            <EmptyState icon="radio" message="No event source wired." hint={data()?.hint} />
          </Card>
        </Show>
        <Show when={data() !== null && data()?.enabled === true}>
          <Card pad={false}>
            <DataTable
              label="Events"
              columns={HEADERS}
              rows={visible()}
              rowKey={(ev): string => ev.id}
              render={rowCells}
              align={[4]}
              empty={
                <EmptyState
                  icon="filter"
                  message="No events match the current filter."
                  hint="Try widening the search or the source filter."
                />
              }
            />
          </Card>
        </Show>
      </Show>
    </div>
  );
};
