/**
 * @fileoverview Events view — the unified event buffer. Interleaves NATS
 * pub/sub rows (NatsEventTracker) and nova typed-realtime / WS trace rows so
 * you can see, side by side, what the app SENT (out) and RECEIVED (in), filter
 * by source/text, publish NATS probe events and clear the whole buffer.
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
import { Chip, DirPill, EmptyState, Panel, StatCard, StatRow } from "../components/widgets";
import { fmtNum, timeAgo, timeHM } from "../format";
import { baselineFrom, currentPulse, domainMoved, lastRevision } from "../live";
import { toast } from "../toast";

type SourceFilter = "all" | "nats" | "nova";

/** One stat card descriptor rendered under the panel header. */
interface Card {
  key: string;
  value: number;
  label: string;
  sub?: string;
  tone?: string;
}

/** One row of the unified buffer (source chip + in/out pill + detail). */
const Row = (props: { ev: DebugEventRow }): JSX.Element => (
  <tr
    title={`${props.ev.source} · ${props.ev.kind} · ${props.ev.direction} · ${timeHM(props.ev.ts)}`}
  >
    <td class="text-muted">{timeAgo(props.ev.ts)}</td>
    <td>
      <DirPill direction={props.ev.direction} />
    </td>
    <td>
      <Chip class="mono">{props.ev.source === "nova" ? "NOVA" : "NATS"}</Chip>
    </td>
    <td class="font-mono">
      {props.ev.name}
      <Show when={props.ev.key !== undefined && props.ev.key !== ""}>
        <span class="text-muted"> → {props.ev.key}</span>
      </Show>
    </td>
    <td class="font-mono text-muted">{`${String(props.ev.size)} B`}</td>
    <td class="font-mono text-muted" title={props.ev.payload}>
      {props.ev.payload !== "" ? props.ev.payload : "—"}
    </td>
    <td class="text-muted">
      {props.ev.error !== null ? (
        <span class="pill status err" title={props.ev.error}>
          err
        </span>
      ) : (
        "—"
      )}
    </td>
  </tr>
);

/** Manual realtime (nova) event composer — fires via `POST /nova/events/emit`. */
const NovaEmitPanel = (props: { onEmitted: () => void }): JSX.Element => {
  const [name, setName] = createSignal("");
  const [target, setTarget] = createSignal("");
  const [body, setBody] = createSignal('{"ok":true}');
  const [result, setResult] = createSignal("");

  const emit = (): void => {
    const evName = name().trim();
    if (evName === "") {
      setResult("event name required");
      return;
    }
    let parsed: unknown = {};
    const raw = body().trim();
    if (raw !== "") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        setResult("payload is not valid JSON");
        return;
      }
    }
    setResult("emitting…");
    void emitNovaEvent(evName, parsed, target().trim())
      .then((res): void => {
        setResult(res.ok ? `✔ ${res.note ?? "emitted"}` : `✖ ${res.error ?? "failed"}`);
        props.onEmitted();
      })
      .catch((err: Error): void => {
        setResult(`✖ ${err.message}`);
      });
  };

  return (
    <Panel title="Emit realtime event (nova)">
      <div class="publish-composer">
        <input
          class="search font-mono"
          type="text"
          placeholder="event, e.g. recive-fe.created"
          spellcheck={false}
          value={name()}
          onInput={(ev): void => {
            setName((ev.target as HTMLInputElement).value);
          }}
        />
        <input
          class="search font-mono"
          type="text"
          placeholder="target — user:u-42 · group:premium · topic:room · client:c-1 (blank = broadcast)"
          spellcheck={false}
          value={target()}
          onInput={(ev): void => {
            setTarget((ev.target as HTMLInputElement).value);
          }}
        />
        <textarea
          class="search font-mono"
          rows={3}
          placeholder='payload JSON, e.g. {"ok":true} — or leave empty'
          value={body()}
          onInput={(ev): void => {
            setBody((ev.target as HTMLTextAreaElement).value);
          }}
        />
        <button type="button" class="primary mini" onClick={emit}>
          ▶ emit
        </button>
        <span class="muted hint">{result()}</span>
      </div>
    </Panel>
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
  const [publishResult, setPublishResult] = createSignal("");

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

  const cards = createMemo((): Card[] => {
    const list: Card[] = [];
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
      setPublishResult("subject required");
      return;
    }
    let parsed: unknown = {};
    const raw = composer().trim();
    if (raw !== "") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        setPublishResult("payload is not valid JSON");
        return;
      }
    }
    setPublishResult("publishing…");
    void publishEvent(subj, parsed)
      .then((res): void => {
        setPublishResult(res.ok ? "✔ published" : `✖ ${res.error ?? "failed"}`);
        load();
      })
      .catch((err: Error): void => {
        setPublishResult(`✖ ${err.message}`);
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

  return (
    <div>
      <Panel
        title="Event buffer"
        hint={
          nova() !== null && nova()?.captures === false ? (
            <span class="muted hint">{captureHint}</span>
          ) : undefined
        }
      >
        <StatRow>
          <For each={cards()}>
            {(c): JSX.Element => (
              <StatCard value={fmtNum(c.value)} label={c.label} sub={c.sub} tone={c.tone} />
            )}
          </For>
        </StatRow>
      </Panel>

      <Show when={nats() !== null}>
        <Panel title="Publish NATS probe event">
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
              value={composer()}
              onInput={(ev): void => {
                setComposer((ev.target as HTMLTextAreaElement).value);
              }}
            />
            <button type="button" class="primary mini" onClick={publish}>
              ▶ publish
            </button>
            <span class="muted hint">{publishResult()}</span>
          </div>
        </Panel>
      </Show>

      <Show when={nova() !== null}>
        <NovaEmitPanel onEmitted={load} />
      </Show>

      <Panel>
        <div class="toolbar">
          <input
            class="search"
            id="search"
            type="text"
            placeholder="filter event / subject / target…"
            value={q()}
            onInput={(ev): void => {
              setQ((ev.target as HTMLInputElement).value);
            }}
          />
          <button
            type="button"
            class={source() === "all" ? "mini primary" : "mini ghost"}
            onClick={(): void => pick("all")}
          >
            All
          </button>
          <button
            type="button"
            class={source() === "nats" ? "mini primary" : "mini ghost"}
            onClick={(): void => pick("nats")}
          >
            NATS
          </button>
          <button
            type="button"
            class={source() === "nova" ? "mini primary" : "mini ghost"}
            onClick={(): void => pick("nova")}
          >
            Nova
          </button>
          <span class="grow" />
          <button type="button" class="ghost mini" onClick={load}>
            ↻ refresh
          </button>
          <button type="button" class="ghost mini" onClick={clear}>
            ✕ clear buffer
          </button>
        </div>
      </Panel>

      <Panel>
        <Show when={loadError() !== ""}>
          <EmptyState glyph="⚠️" message="could not load events" hint={loadError()} />
        </Show>
        <Show when={loadError() === ""} fallback={null}>
          <Show when={data() === null}>
            <EmptyState glyph="…" message="loading events…" />
          </Show>
          <Show when={data() !== null && data()?.enabled === false}>
            <EmptyState glyph="🔌" message="No event source wired." hint={data()?.hint} />
          </Show>
          <Show when={data() !== null && data()?.enabled === true}>
            <Show when={visible().length === 0}>
              <EmptyState
                glyph="🔍"
                message="No events match the current filter."
                hint="Try widening the search or the source filter."
              />
            </Show>
            <Show when={visible().length > 0}>
              <table>
                <thead>
                  <tr>
                    {["When", "Dir", "Source", "Event", "Size", "Payload", "Error"].map(
                      (l): JSX.Element => (
                        <th>{l}</th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  <For each={visible()}>{(ev): JSX.Element => <Row ev={ev} />}</For>
                </tbody>
              </table>
            </Show>
          </Show>
        </Show>
      </Panel>
    </div>
  );
};
