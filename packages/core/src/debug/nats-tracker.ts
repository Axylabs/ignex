/**
 * @fileoverview NATS event tracking for the debugbar — a zero-dependency
 * minimal NATS client (Bun TCP) plus a bounded event ring buffer.
 *
 * Two layers:
 *
 * 1. {@link NatsConnection} — a minimal client for the NATS **core protocol**
 *    (INFO/CONNECT/PING/PONG/PUB/SUB/MSG) over a raw Bun TCP socket. No
 *    JetStream, no TLS client certs — exactly what a developer debugger needs
 *    to subscribe to subjects and publish probe events. Protocol errors are
 *    never thrown at callers: the connection surfaces a `status` string and
 *    the tracker records failures as events.
 *
 * 2. {@link NatsEventTracker} — the debugbar-facing tracker. It owns the
 *    connection lifecycle (connect → subscribe → reconnect with backoff),
 *    records every outbound publish and inbound message into a bounded ring
 *    buffer, and exposes the `/__debugbar/api/events*` contract (list, stats,
 *    publish, clear).
 *
 * The whole module degrades gracefully: without a `NATS_URL` the tracker is
 * `enabled: false` and every accessor returns empty data — the debugbar keeps
 * working, the events panel just shows a "not configured" hint.
 */

/** One tracked NATS event (outbound publish or inbound message). */
export interface NatsEvent {
  /** Stable id (monotonic counter + timestamp). */
  readonly id: string;
  /** Epoch ms when the event was recorded. */
  readonly ts: number;
  /** `out` = published by this process, `in` = received from the bus. */
  readonly direction: "out" | "in";
  /** Subject the event was published to / received on. */
  readonly subject: string;
  /** Payload text (JSON-stringified or raw string), truncated to a cap. */
  readonly payload: string;
  /** UTF-8 byte size of the payload before truncation. */
  readonly size: number;
  /** Error message when the publish/recv failed, else null. */
  readonly error: string | null;
}

/** Compact row served to the dashboard (truncated payload included). */
export interface NatsEventSummary {
  readonly id: string;
  readonly ts: number;
  readonly direction: "out" | "in";
  readonly subject: string;
  /** Truncated payload text (cap: `maxPayloadChars`). */
  readonly payload: string;
  readonly size: number;
  readonly error: string | null;
}

/** Aggregate stats over the retained buffer. */
export interface NatsEventStats {
  readonly enabled: boolean;
  readonly connected: boolean;
  readonly url: string | null;
  readonly status: string;
  readonly total: number;
  readonly out: number;
  readonly in: number;
  readonly errors: number;
  readonly bytes: number;
  readonly bySubject: Record<string, number>;
  readonly subjects: readonly string[];
}

/** Options for {@link NatsEventTracker}. */
export interface NatsTrackerOptions {
  /** NATS server URL, e.g. `nats://localhost:4222`. Also read from `NATS_URL`. */
  url?: string;
  /** Subjects to subscribe to (inbound tracking). Default `["events.>"]`. */
  subjects?: readonly string[];
  /** Max retained events (ring buffer). Default 500. */
  maxEvents?: number;
  /** Connect at startup. Default true (best effort — never throws). */
  connect?: boolean;
  /** Payload truncation cap in chars. Default 4000. */
  maxPayloadChars?: number;
  /**
   * Mutation notification (record/clear) — used by the debugbar's live-stream
   * revision counters; called after each recorded event.
   */
  onNotify?: () => void;
}

/** Connection status string, monotonic across (re)connect attempts. */
export type NatsStatus =
  | "disabled" // no URL configured
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed"
  | "error";

const DEFAULT_PORT = 4222;
const KEEPALIVE_MS = 20_000;
const RECONNECT_MS = 5_000;
const MAX_RECONNECT_ATTEMPTS = 6;

interface NatsUrlParts {
  hostname: string;
  port: number;
  user: string | undefined;
  pass: string | undefined;
  tls: boolean;
}

/** Parse `nats://[user:pass@]host[:port]` (tls:// also accepted). */
const parseNatsUrl = (raw: string): NatsUrlParts | null => {
  const match = /^(nats|tls):\/\/(?:([^:/\s@]+):([^@/\s]*)@)?([^:/\s@]+)(?::(\d+))?\/?$/.exec(
    raw.trim(),
  );
  if (!match) return null;
  const [, scheme, user, pass, hostname, portRaw] = match;
  if (hostname === undefined || hostname === "") return null;
  return {
    hostname,
    port: portRaw !== undefined ? Number(portRaw) : DEFAULT_PORT,
    user: user || undefined,
    pass: pass || undefined,
    tls: scheme === "tls",
  };
};

/** Event id generator (counter + random suffix, monotonic enough for the UI). */
let eventSeq = 0;
const nextEventId = (): string => {
  eventSeq += 1;
  return `ev-${Date.now().toString(36)}-${eventSeq.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
};

/**
 * Minimal NATS core-protocol client over Bun TCP.
 *
 * Surface: `connect()`, `publish(subject, payload)`, `subscribe(subject)`,
 * `close()` and an `onMessage` callback. Never throws into the caller: every
 * failure is reported through `status` (and, where relevant, a `lastError`).
 */
export class NatsConnection {
  /** Current connection status. */
  status: NatsStatus = "disabled";
  /** Last protocol/connection error message, if any. */
  lastError: string | null = null;
  /** Server version from INFO (when connected). */
  serverVersion: string | null = null;

  private readonly url: string;
  private socket: import("bun").Socket<unknown> | null = null;
  private buffer = "";
  private closedByUs = false;
  private sid = 0;
  private readonly subs = new Map<number, string>(); // sid → subject (raw pattern)
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  /** Resolve/queue for connect() while a connection is being established. */
  private connectPromise: Promise<void> | null = null;
  private readonly onMessage: (subject: string, payload: Uint8Array) => void;

  constructor(url: string, onMessage: (subject: string, payload: Uint8Array) => void) {
    this.url = url;
    this.onMessage = onMessage;
  }

  /** True when a live socket is up. */
  get isConnected(): boolean {
    return this.status === "connected" && this.socket !== null;
  }

  /** Human summary (url + status) for the dashboard. */
  describe(): string {
    return `${this.url} (${this.status}${this.serverVersion ? ` · ${this.serverVersion}` : ""})`;
  }

  /** Open the connection (idempotent while connecting). */
  connect(): Promise<void> {
    if (this.isConnected || this.status === "connecting") {
      return this.connectPromise ?? Promise.resolve();
    }
    const parsed = parseNatsUrl(this.url);
    if (!parsed) {
      this.status = "error";
      this.lastError = `Invalid NATS URL "${this.url}" — expected nats://host[:port]`;
      return Promise.resolve();
    }

    this.status = "connecting";
    this.closedByUs = false;
    this.connectPromise = new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      try {
        const socket = Bun.connect({
          hostname: parsed.hostname,
          port: parsed.port,
          ...(parsed.tls ? { tls: true } : {}),
          socket: {
            open: (sock) => {
              this.socket = sock;
              this.buffer = "";
              this.reconnectAttempts = 0;
              // Handshake: CONNECT (with optional auth) + subscribe to the
              // pending subjects. The server answers with INFO first.
              const connectLine: Record<string, unknown> = {
                verbose: false,
                pedantic: false,
                lang: "js",
                version: "ignex-debugbar",
              };
              if (parsed.user !== undefined) {
                connectLine.user = parsed.user;
                connectLine.pass = parsed.pass ?? "";
              }
              sock.write(`CONNECT ${JSON.stringify(connectLine)}\r\n`);
              sock.write("PING\r\n");
              for (const [sid, subject] of this.subs) {
                sock.write(`SUB ${subject} ${sid}\r\n`);
              }
              this.status = "connected";
              this.lastError = null;
              this.startKeepalive();
              done();
            },
            data: (sock, data) => {
              this.buffer += typeof data === "string" ? data : Buffer.from(data).toString("utf8");
              this.consume(sock);
            },
            close: () => {
              this.socket = null;
              this.stopKeepalive();
              if (this.closedByUs) {
                this.status = "closed";
              } else {
                this.status = "reconnecting";
                this.scheduleReconnect();
              }
              done();
            },
            error: (err) => {
              this.lastError = err instanceof Error ? err.message : String(err);
              this.status = "error";
              try {
                this.socket?.close();
              } catch {
                // already closed
              }
              this.socket = null;
              this.stopKeepalive();
              if (!this.closedByUs) this.scheduleReconnect();
              done();
            },
          },
        });
        // Bun.connect resolves the socket synchronously in the open callback;
        // a rejected promise means the connect failed (e.g. ECONNREFUSED).
        if (socket instanceof Promise) {
          socket.then(
            (s) => {
              // Socket open happened via the callback above; nothing to do.
              void s;
            },
            (err: unknown) => {
              this.lastError = err instanceof Error ? err.message : String(err);
              this.status = "error";
              done();
              if (!this.closedByUs) this.scheduleReconnect();
            },
          );
        }
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.status = "error";
        done();
      }
    });
    return this.connectPromise;
  }

  /** Subscribe to a subject pattern (e.g. `events.>`); idempotent per subject. */
  subscribe(subject: string): void {
    const existing = [...this.subs.entries()].find(([, s]) => s === subject);
    if (existing) return;
    this.sid += 1;
    this.subs.set(this.sid, subject);
    this.socket?.write(`SUB ${subject} ${this.sid}\r\n`);
  }

  /** Publish a payload to a subject (fire-and-forget; failure → status). */
  publish(subject: string, payload: string): boolean {
    if (!this.isConnected || this.socket === null) {
      this.lastError = "not connected";
      return false;
    }
    const bytes = Buffer.byteLength(payload, "utf8");
    try {
      this.socket.write(`PUB ${subject} ${bytes}\r\n${payload}\r\n`);
      return true;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  /** Close the connection and stop reconnects. */
  close(): void {
    this.closedByUs = true;
    this.stopKeepalive();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.socket?.close();
    } catch {
      // already closed
    }
    this.socket = null;
    this.status = "closed";
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepalive = setInterval(() => {
      // PING → PONG keeps the connection alive through proxies/idle timeouts.
      if (this.isConnected) this.socket?.write("PING\r\n");
    }, KEEPALIVE_MS);
  }

  private stopKeepalive(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
  }

  private scheduleReconnect(): void {
    if (this.closedByUs || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      this.status = "error";
      this.lastError = `gave up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`;
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.status = "reconnecting";
      void this.connect();
    }, RECONNECT_MS * this.reconnectAttempts);
  }

  /** Incrementally parse the NATS protocol stream. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a linear protocol parser — one branch per control line
  private consume(socket: import("bun").Socket<unknown>): void {
    // NATS protocol lines end with \r\n; MSG/PUB payloads are length-prefixed.
    for (;;) {
      const lineEnd = this.buffer.indexOf("\r\n");
      if (lineEnd === -1) return;
      const line = this.buffer.slice(0, lineEnd);
      this.buffer = this.buffer.slice(lineEnd + 2);
      if (line === "") continue;

      if (line.startsWith("INFO ")) {
        try {
          const info = JSON.parse(line.slice(5)) as { version?: string; server_name?: string };
          this.serverVersion = info.version ?? null;
        } catch {
          // ignore malformed INFO
        }
        continue;
      }
      if (line === "PING") {
        socket.write("PONG\r\n");
        continue;
      }
      if (line === "PONG") continue;
      if (line === "+OK") continue;
      if (line.startsWith("-ERR")) {
        this.lastError = line.slice(4).trim();
        continue;
      }
      if (line.startsWith("MSG ")) {
        const parts = line.split(" ");
        // MSG <subject> <sid> [reply-to] <#bytes> — the size is ALWAYS the
        // last token (a reply-to only appears when the publisher set one).
        const sizeRaw = parts[parts.length - 1];
        const size = sizeRaw !== undefined ? Number(sizeRaw) : 0;
        if (Number.isNaN(size) || size < 0) {
          this.lastError = "malformed MSG size";
          continue;
        }
        if (this.buffer.length < size + 2) {
          // Wait for the full payload — restore the line to the buffer.
          this.buffer = `${line}\r\n${this.buffer}`;
          return;
        }
        const payload = this.buffer.slice(0, size);
        this.buffer = this.buffer.slice(size + 2);
        const subject = parts[1] ?? "";
        this.onMessage(subject, Buffer.from(payload, "utf8"));
      }
      // Unknown control line — ignore.
    }
  }
}

/** Bounded ring buffer of NATS events + connection lifecycle owner. */
export class NatsEventTracker {
  readonly enabled: boolean;
  readonly url: string | null;
  readonly subjects: readonly string[];
  readonly maxEvents: number;
  readonly maxPayloadChars: number;

  private conn: NatsConnection | null = null;
  private readonly events: NatsEvent[] = [];
  private started = false;

  private readonly onNotify: (() => void) | null;

  constructor(options: NatsTrackerOptions = {}) {
    this.onNotify = options.onNotify ?? null;
    const url = options.url ?? process.env.NATS_URL ?? null;
    this.enabled = url !== null && url !== "";
    this.url = url;
    this.subjects = options.subjects ?? ["events.>"];
    this.maxEvents = options.maxEvents ?? 500;
    this.maxPayloadChars = options.maxPayloadChars ?? 4000;
    // The connection object exists whenever NATS is configured — `connect`
    // only controls whether we DIAL now. This keeps publish() recording the
    // attempt (and its failure) even when the server is down or connecting
    // was deferred, so the Events panel always shows what happened.
    if (this.enabled && url !== null) {
      this.conn = new NatsConnection(url, (subject, payload) => {
        this.record("in", subject, Buffer.from(payload).toString("utf8"), null);
      });
      if (options.connect !== false) this.start();
    }
  }

  /** Start connecting + subscribing (best effort — never throws). */
  start(): void {
    if (this.started || !this.conn) return;
    this.started = true;
    void this.connect();
  }

  /** Stop the connection (keeps the retained buffer). */
  stop(): void {
    this.conn?.close();
    this.started = false;
  }

  private async connect(): Promise<void> {
    if (!this.conn) return;
    await this.conn.connect();
    for (const subject of this.subjects) this.conn.subscribe(subject);
  }

  /** Publish a JSON-able payload to a subject and record the attempt. */
  publish(subject: string, payload: unknown): { ok: boolean; error: string | null } {
    if (!this.conn) return { ok: false, error: "NATS not configured (no NATS_URL)" };
    const text = typeof payload === "string" ? payload : safeStringify(payload);
    const ok = this.conn.publish(subject, text);
    this.record("out", subject, text, ok ? null : (this.conn.lastError ?? "publish failed"));
    return { ok, error: ok ? null : (this.conn.lastError ?? "publish failed") };
  }

  /** Record an inbound/outbound event into the ring buffer. */
  record(direction: "in" | "out", subject: string, payload: string, error: string | null): void {
    const size = Buffer.byteLength(payload, "utf8");
    const truncated =
      payload.length > this.maxPayloadChars ? payload.slice(0, this.maxPayloadChars) : payload;
    this.events.push({
      id: nextEventId(),
      ts: Date.now(),
      direction,
      subject,
      payload: truncated,
      size,
      error,
    });
    if (this.events.length > this.maxEvents) this.events.shift();
    this.onNotify?.();
  }

  /** Recent events, newest first, optional filters. */
  list(
    options: { limit?: number; subject?: string; direction?: "in" | "out" } = {},
  ): NatsEventSummary[] {
    const limit = options.limit ?? 100;
    const out: NatsEventSummary[] = [];
    for (let i = this.events.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.events[i];
      if (e === undefined) continue;
      if (
        options.subject &&
        e.subject !== options.subject &&
        !e.subject.startsWith(options.subject)
      )
        continue;
      if (options.direction && e.direction !== options.direction) continue;
      out.push({
        id: e.id,
        ts: e.ts,
        direction: e.direction,
        subject: e.subject,
        payload: e.payload,
        size: e.size,
        error: e.error,
      });
    }
    return out;
  }

  /** Full event by id (payload included). */
  get(id: string): NatsEvent | undefined {
    return this.events.find((e) => e.id === id);
  }

  /** Drop the buffer (connection stays up). */
  clear(): void {
    this.events.length = 0;
    this.onNotify?.();
  }

  /** Aggregate stats. */
  stats(): NatsEventStats {
    const bySubject: Record<string, number> = {};
    let out = 0;
    let inCount = 0;
    let errors = 0;
    let bytes = 0;
    for (const e of this.events) {
      bySubject[e.subject] = (bySubject[e.subject] ?? 0) + 1;
      if (e.direction === "out") out += 1;
      else inCount += 1;
      if (e.error) errors += 1;
      bytes += e.size;
    }
    return {
      enabled: this.enabled,
      connected: this.conn?.isConnected ?? false,
      url: this.url,
      status: this.conn?.status ?? "disabled",
      total: this.events.length,
      out,
      in: inCount,
      errors,
      bytes,
      bySubject,
      subjects: this.subjects,
    };
  }
}

/** JSON.stringify that never throws (cycles → "…"). */
const safeStringify = (value: unknown): string => {
  try {
    const text = JSON.stringify(value);
    return text ?? String(value);
  } catch {
    return String(value);
  }
};
