/**
 * Debugbar API client — URL/token construction, error surfacing and the live
 * stream's reconnect budget.
 *
 * The client is the single place that knows the mount path, the `x-debugbar-token`
 * header and how filters become a query string. Getting any of those wrong is
 * invisible until the dashboard silently shows empty panels, so they are pinned
 * here against a stubbed `fetch`.
 */

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

let calls: Call[] = [];
let reply: { ok: boolean; status: number; json: () => Promise<unknown> };

/** Point the stub at a response body (and reset the captured calls). */
const respond = (body: unknown, status = 200): void => {
  calls = [];
  reply = {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
};

/** Point the stub at a body that is not valid JSON. */
const respondUnparseable = (status: number): void => {
  calls = [];
  reply = {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
  };
};

const api = async () => import("../src/debug/ui/api");

beforeEach(() => {
  respond({});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return reply as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const headersOf = (call: Call): Record<string, string> =>
  (call.init?.headers ?? {}) as Record<string, string>;

describe("mount path and auth", () => {
  it("defaults the mount path to the current directory", async () => {
    const { BASE } = await api();
    expect(BASE).toBe(".");
  });

  it("sends the debugbar token on every JSON GET", async () => {
    const { getMeta } = await api();
    respond({ serviceName: "app" });

    await getMeta();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("./api/meta");
    expect(headersOf(calls[0] as Call)["x-debugbar-token"]).toBe("");
    expect(headersOf(calls[0] as Call).accept).toBe("application/json");
  });
});

describe("filter serialization", () => {
  it("defaults the limit and drops empty/false filters", async () => {
    const { getRequests } = await api();
    respond([]);

    await getRequests({ q: "", method: undefined, errorsOnly: false });

    const query = new URL(calls[0]?.url ?? "", "http://debugbar.test").searchParams;
    expect(query.get("limit")).toBe("200");
    expect(query.has("q")).toBe(false);
    expect(query.has("method")).toBe(false);
    expect(query.has("error")).toBe(false);
  });

  it("serializes active filters, flags booleans as 1 and honours the limit", async () => {
    const { getRequests } = await api();
    respond([]);

    await getRequests({
      q: "slow",
      method: "POST",
      status: "5xx",
      code: "IGN_DB_CREDENTIALS",
      minMs: "250",
      errorsOnly: true,
      limit: 50,
    });

    const query = new URL(calls[0]?.url ?? "", "http://debugbar.test").searchParams;
    expect(query.get("q")).toBe("slow");
    expect(query.get("method")).toBe("POST");
    expect(query.get("status")).toBe("5xx");
    expect(query.get("code")).toBe("IGN_DB_CREDENTIALS");
    expect(query.get("minMs")).toBe("250");
    expect(query.get("error")).toBe("1");
    expect(query.get("limit")).toBe("50");
  });

  it("applies the same filters to the history endpoint", async () => {
    const { getHistory } = await api();
    respond({ enabled: true, rows: [] });

    await getHistory({ q: "x", limit: 10 });

    expect(calls[0]?.url).toBe("./api/history?q=x&limit=10");
  });
});

describe("path encoding", () => {
  it("encodes a trace id", async () => {
    const { getRequestDetail } = await api();
    respond({});

    await getRequestDetail("a/b c");

    expect(calls[0]?.url).toBe("./api/requests/a%2Fb%20c");
  });

  it("encodes a doc path", async () => {
    const { getDoc } = await api();
    respond({});

    await getDoc("docs/getting started.md");

    expect(calls[0]?.url).toBe("./api/docs?path=docs%2Fgetting%20started.md");
  });
});

describe("optional query flags", () => {
  it("only asks for a client refresh when requested", async () => {
    const { getClients } = await api();
    respond({ enabled: true, count: 0, clients: [] });

    await getClients();
    expect(calls[0]?.url).toBe("./api/clients");

    await getClients(true);
    expect(calls[1]?.url).toBe("./api/clients?refresh=1");
  });

  it("threads the events limit", async () => {
    const { getEvents } = await api();
    respond({ events: [] });

    await getEvents(10);
    expect(calls[0]?.url).toBe("./api/events?limit=10");

    await getEvents();
    expect(calls[1]?.url).toBe("./api/events?limit=250");
  });

  it("defaults the logs limit and only forwards set options", async () => {
    const { getLogs } = await api();
    respond({ enabled: true, persisted: false, records: [], stats: null });

    await getLogs({});
    expect(calls[0]?.url).toBe("./api/logs?limit=300");

    await getLogs({ q: "boom", level: "error", persisted: true, limit: 5 });
    expect(calls[1]?.url).toBe("./api/logs?limit=5&q=boom&level=error&persisted=1");
  });
});

describe("POST bodies", () => {
  it("omits the body and content-type for a bare POST", async () => {
    const { clearRequests } = await api();
    respond({ ok: true });

    await clearRequests();

    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(headersOf(calls[0] as Call)["content-type"]).toBeUndefined();
  });

  it("sends JSON with a content-type when there is a body", async () => {
    const { publishEvent } = await api();
    respond({ ok: true });

    await publishEvent("probe.hello", { n: 1 });

    expect(headersOf(calls[0] as Call)["content-type"]).toBe("application/json");
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({ subject: "probe.hello", payload: { n: 1 } }),
    );
  });

  it("includes a target only when one is given", async () => {
    const { emitNovaEvent } = await api();
    respond({ ok: true });

    await emitNovaEvent("chat.message", { text: "hi" }, "user:u-42");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "chat.message",
      payload: { text: "hi" },
      target: "user:u-42",
    });

    await emitNovaEvent("chat.message", { text: "hi" }, "");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      name: "chat.message",
      payload: { text: "hi" },
    });
  });
});

describe("error surfacing", () => {
  it("throws the status and path on a non-2xx GET", async () => {
    const { getMeta } = await api();
    respond({ message: "nope" }, 500);

    await expect(getMeta()).rejects.toThrow("HTTP 500 /meta");
  });

  it("throws on a non-2xx POST with an unparseable body", async () => {
    const { clearLogs } = await api();
    respondUnparseable(503);

    await expect(clearLogs()).rejects.toThrow("HTTP 503 /logs/clear");
  });

  it("returns the parsed body on success", async () => {
    const { getState } = await api();
    respond({ uptime: 12 });

    await expect(getState()).resolves.toEqual({ uptime: 12 });
  });
});

describe("openStream", () => {
  /** Captured fake EventSource instances. */
  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    readonly listeners = new Map<string, (ev: MessageEvent<string>) => void>();
    onerror: (() => void) | null = null;
    onopen: (() => void) | null = null;
    closed = false;

    constructor(readonly url: string) {
      FakeEventSource.instances.push(this);
    }

    addEventListener(type: string, cb: (ev: MessageEvent<string>) => void): void {
      this.listeners.set(type, cb);
    }

    emitRevision(data: string): void {
      this.listeners.get("revision")?.({ data } as MessageEvent<string>);
    }

    fail(): void {
      this.onerror?.();
    }

    close(): void {
      this.closed = true;
    }
  }

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.useFakeTimers();
  });

  it("mints a ticket, then subscribes to the stream", async () => {
    const { openStream } = await api();
    respond({ ticket: "t-1" });

    const close = openStream({ onRevision: () => {}, onDown: () => {} });
    await flush();

    expect(calls[0]?.url).toBe("./api/stream/ticket");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(FakeEventSource.instances[0]?.url).toBe("./api/stream?ticket=t-1");

    close();
  });

  it("delivers revision frames and ignores malformed ones", async () => {
    const { openStream } = await api();
    respond({ ticket: "t-1" });

    const seen: number[] = [];
    const close = openStream({ onRevision: (rev) => seen.push(rev.traces), onDown: () => {} });
    await flush();

    const es = FakeEventSource.instances[0];
    es?.emitRevision(JSON.stringify({ traces: 7, logs: 0, metrics: 0, system: 0, events: 0 }));
    es?.emitRevision("{not json");

    expect(seen).toEqual([7]);
    close();
  });

  it("reconnects with a fresh ticket and gives up after the retry budget", async () => {
    const { openStream } = await api();
    respond({ ticket: "t" });

    let down = 0;
    const close = openStream({ onRevision: () => {}, onDown: () => down++ });
    await flush();

    // Each failure consumes one backoff slot: 0ms, 1s, 5s, then onDown.
    for (let i = 0; i < 4; i++) {
      FakeEventSource.instances[i]?.fail();
      await flush();
      await vi.advanceTimersByTimeAsync(5000);
      await flush();
    }

    expect(FakeEventSource.instances).toHaveLength(4);
    expect(FakeEventSource.instances.every((es) => es.closed)).toBe(true);
    expect(down).toBe(1);

    close();
  });

  it("stops reconnecting after close", async () => {
    const { openStream } = await api();
    respond({ ticket: "t" });

    const close = openStream({ onRevision: () => {}, onDown: () => {} });
    await flush();

    FakeEventSource.instances[0]?.fail();
    await flush();
    close();

    await vi.advanceTimersByTimeAsync(10_000);
    await flush();

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
  });
});
