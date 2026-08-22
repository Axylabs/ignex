/**
 * Wire-format security + robustness tests.
 *
 * Pins the transport's attack surface and trust model:
 *   - Envelope integrity: `[event_id][size-prefixed FlatBuffer]` invariants,
 *     deterministic bytes, and proof the wire carries binary data (not JSON).
 *   - Hostile-frame robustness: the DECODER must never throw / read out of
 *     bounds on empty, truncated, out-of-range-id, or corrupted-size-prefix
 *     frames from an untrusted peer. Note the documented trust model: the
 *     decoder trusts the envelope id byte — there is NO per-frame checksum or
 *     authentication, so integrity/AuthN is the application's job.
 *   - Encoder/FFI boundary: unknown event names and malformed JSON are rejected;
 *     the FFI needed-size convention (`0`=error, `w>cap`=exact) is honored and
 *     transparently retried.
 *   - Injection isolation: unknown object keys and prototype-pollution keys
 *     (`__proto__`, `constructor.prototype`) are dropped — they can't leak onto
 *     the wire or pollute JS globals; hostile string content (HTML/JS, NUL)
 *     cannot corrupt the frame or masquerade as envelope metadata.
 *   - Broadcast integrity: every subscriber receives byte-identical frames.
 *
 * Requires: `bun run generate` + `cargo build --release`.
 */
import { describe, expect, test } from "bun:test";
import { createServer } from "../public/server";
import {
  decodeFrame,
  eventNameToId,
  isControlId,
  WIRE_HEADER_LEN,
  WIRE_VERSION,
} from "../src/generated/registry";
import { getFfi } from "../src/native/ffi";
import type { EventName, Events } from "../src/schema";
import { encodeEvent, encodeToScratch } from "../src/transport/transport";
import { bytesContain, frameId, payloads, sizePrefix } from "./helpers";

describe("wire-format envelope integrity", () => {
  test("frame invariant holds for every event ([version][event_id:u32] + size prefix == payload length)", () => {
    for (const name of Object.keys(payloads) as EventName[]) {
      const frame = encodeEvent(name, payloads[name]);
      expect(frame[0]).toBe(WIRE_VERSION);
      expect(frameId(frame)).toBe(eventNameToId[name]);
      // bytes WIRE_HEADER_LEN..+4 are the LE size prefix; == flatbuffer length
      expect(sizePrefix(frame)).toBe(frame.byteLength - WIRE_HEADER_LEN - 4);
      // and the payload region must decode back to a structurally valid object
      const decoded = decodeFrame(frame);
      expect(decoded?.name).toBe(name);
    }
  });

  test("encoding is deterministic — identical payloads produce byte-identical frames", () => {
    for (const name of Object.keys(payloads) as EventName[]) {
      const a = encodeEvent(name, payloads[name]);
      const b = encodeEvent(name, payloads[name]);
      expect(a.byteLength).toBe(b.byteLength);
      expect(a.every((byte, i) => byte === b[i])).toBe(true);
    }
  });

  test("wire bytes carry the payload data, not a JSON envelope (direct path)", () => {
    const q = { ...(payloads.quote as Events["quote"]), symbol: "INTEGRITY-PROBE-12345" };
    const frame = encodeEvent("quote", q);
    // the actual string value is present in the flatbuffer payload region
    expect(bytesContain(frame.subarray(WIRE_HEADER_LEN), new TextEncoder().encode(q.symbol))).toBe(
      true,
    );
    // the direct path must NOT embed the JSON source: no `"symbol"`/`"bid"` keys
    expect(bytesContain(frame, new TextEncoder().encode('{"symbol"'))).toBe(false);
    expect(bytesContain(frame, new TextEncoder().encode('"bid"'))).toBe(false);
  });
});

describe("hostile-frame robustness (untrusted decoder input)", () => {
  test("empty frame is rejected with null — no crash", () => {
    expect(decodeFrame(new Uint8Array(0))).toBeNull();
  });

  test("out-of-range event ids are rejected with null (unknown u32 ids)", () => {
    const base = encodeEvent("quote", payloads.quote);
    for (const id of [0, 5, 99, 128, 255, 0x7fff_ffff, 0xffff_ffff]) {
      const f = base.slice();
      new DataView(f.buffer, f.byteOffset).setUint32(1, id, true);
      expect(decodeFrame(f)).toBeNull();
    }
  });

  test("wrong wire version byte is rejected with null (stale/foreign frames)", () => {
    const frame = encodeEvent("quote", payloads.quote);
    for (const v of [0, 2, 99, 255]) {
      const f = frame.slice();
      f[0] = v;
      expect(decodeFrame(f)).toBeNull();
    }
  });

  test("truncated frames decode without throwing (flatbuffer defaults, no OOB)", () => {
    const frame = encodeEvent("quote", payloads.quote);
    for (let len = 1; len <= Math.floor(frame.byteLength / 2); len++) {
      const sub = frame.subarray(0, len);
      let threw = false;
      let result: unknown = null;
      try {
        result = decodeFrame(sub);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      if (len < WIRE_HEADER_LEN) {
        // shorter than the envelope header → rejected as null
        expect(result).toBeNull();
      } else {
        // header present, truncated flatbuffer → decodes to defaults, still a quote
        expect((result as { name?: unknown } | null)?.name).toBe("quote");
      }
    }
  });

  test("corrupted size prefix (0, huge) never crashes the decoder", () => {
    const frame = encodeEvent("quote", payloads.quote);
    for (const val of [0, 0x7fff_ffff, 0xffff_ffff]) {
      const f = frame.slice();
      new DataView(f.buffer, f.byteOffset).setUint32(WIRE_HEADER_LEN, val, true);
      let threw = false;
      try {
        decodeFrame(f);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    }
  });

  test("mismatched id vs payload decodes as the id's type without throwing (documented trust model)", () => {
    // The decoder trusts the envelope id (no per-frame checksum/auth).
    // A hostile peer that lies about the id must not crash the decoder or
    // read out of bounds — it simply gets a structurally valid object of the
    // id's type. Integrity/AuthN of the wire is the application's job.
    const tradeFrame = encodeEvent("trade", payloads.trade).slice();
    new DataView(tradeFrame.buffer, tradeFrame.byteOffset).setUint32(1, eventNameToId.quote, true); // lie
    const decoded = decodeFrame(tradeFrame);
    expect(decoded?.name).toBe("quote");
    expect(typeof (decoded!.payload as { symbol?: unknown }).symbol).toBe("string");
  });
});

describe("encoder / FFI boundary validation", () => {
  test("unknown event names are rejected at encode time (both paths throw)", () => {
    expect(() => encodeEvent("nope" as never, {})).toThrow(/unknown event/);
    expect(() => encodeToScratch("nope" as never, {})).toThrow(/unknown event/);
  });

  test("malformed JSON to fb_serialize returns 0 (error sentinel)", () => {
    const ffi = getFfi();
    expect(ffi.fb_serialize(eventNameToId.quote, "{bad", new Uint8Array(4096))).toBe(0);
  });

  test("FFI needed-size convention: tiny out returns exact size; growth retry matches encodeEvent", () => {
    const ffi = getFfi();
    const json = JSON.stringify(payloads.quote);
    const tiny = new Uint8Array(1);
    const w = ffi.fb_serialize(eventNameToId.quote, json, tiny);
    expect(w).toBeGreaterThan(tiny.byteLength); // w > cap → exact size required
    // a fresh encode produces the same length, so the retry is byte-exact
    expect(w).toBe(encodeEvent("quote", payloads.quote).byteLength);

    const full = new Uint8Array(w); // exactly the needed capacity
    const w2 = ffi.fb_serialize(eventNameToId.quote, json, full);
    expect(w2).toBe(w);
    expect(w2).toBeLessThanOrEqual(full.byteLength);
    expect(Bun.deepEquals(decodeFrame(full.subarray(0, w2))?.payload, payloads.quote)).toBe(true);
  });
});

describe("injection & content isolation", () => {
  test("unknown object keys are dropped on both paths — no field injection", () => {
    // JSON fallback path (order): extra keys must not reach the decoded object
    const order = { ...(payloads.order as Events["order"]), extraUnknown: 42, polluted: "x" };
    const orderOut = decodeFrame(encodeEvent("order", order))?.payload as Record<string, unknown>;
    expect("extraUnknown" in orderOut).toBe(false);
    expect("polluted" in orderOut).toBe(false);

    // direct path (quote): the encoder only reads known fields
    const quote = { ...(payloads.quote as Events["quote"]), extraUnknown: 1 };
    const quoteOut = decodeFrame(encodeEvent("quote", quote))?.payload as Record<string, unknown>;
    expect("extraUnknown" in quoteOut).toBe(false);
  });

  test("prototype-pollution keys (__proto__, constructor.prototype) cannot pollute JS globals", () => {
    // Build the hostile payload via JSON.parse so __proto__/constructor are OWN
    // keys (an object literal `__proto__` only sets the prototype).
    const hostile = JSON.parse(
      '{"orderId":"o","customer":{"id":"c","name":"n","vip":true,"loyaltyPoints":1,"rating":1},' +
        '"lines":[{"sku":"s","qty":1,"unitPrice":1,"tags":["hot"]}],"notes":["n"],"discounts":[0.1],' +
        '"active":true,"createdAt":1,"__proto__":{"hacked":true},"constructor":{"prototype":{"polluted":true}}}',
    );
    const decoded = decodeFrame(encodeEvent("order", hostile));
    expect(decoded).not.toBeNull();
    // neither the global Object prototype nor Object.prototype got polluted
    expect(({} as Record<string, unknown>).hacked).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(
      ({}.constructor as { prototype?: Record<string, unknown> }).prototype?.polluted,
    ).toBeUndefined();
    // and the hostile keys did not leak into the decoded payload as OWN keys
    // (`'__proto__' in obj` is true for every object — the accessor lives on
    // Object.prototype — so check for an own property instead).
    expect(Object.hasOwn(decoded!.payload as object, "__proto__")).toBe(false);
    expect(Object.hasOwn(decoded!.payload as object, "constructor")).toBe(false);
  });

  test("HTML/JS-special content round-trips exactly (binary transport is injection-safe)", () => {
    const symbol = '<script>alert("xss")</script> & "quoted" \'single\' <b> \\ \n \t';
    const q = { ...(payloads.quote as Events["quote"]), symbol };
    const out = decodeFrame(encodeEvent("quote", q))?.payload as Events["quote"];
    expect(out.symbol).toBe(symbol);
  });

  test("embedded NUL strings round-trip exactly (routed to the JSON path, not truncated)", () => {
    // The `cstring` direct path truncates at the first \0 (NUL-terminated by
    // definition), so encodeToScratch pre-scans and routes NUL-containing
    // payloads to the JSON path, which preserves them exactly (JSON.stringify
    // escapes \u0000; flatbuffers strings are length-prefixed). No silent loss.
    const q = { ...(payloads.quote as Events["quote"]), symbol: "IGNX\u0000evil" };
    const out = decodeFrame(encodeEvent("quote", q))?.payload as Events["quote"];
    expect(out.symbol).toBe("IGNX\u0000evil");
  });
});

describe("broadcast integrity", () => {
  test("every subscriber receives byte-identical, uncorrupted frames for the same publish", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const N = 3; // concurrent subscribers
    const M = 50; // publishes
    const received: Uint8Array[][] = Array.from({ length: N }, () => []);
    const sockets: WebSocket[] = [];

    const clients = Array.from({ length: N }, (_, i) => {
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      sockets.push(ws);
      const opened = new Promise<void>((resolve) => (ws.onopen = () => resolve()));
      const done = new Promise<void>((resolve) => {
        ws.onmessage = (ev) => {
          const bytes = new Uint8Array(ev.data as ArrayBuffer).slice();
          const frame = decodeFrame(bytes);
          if (!frame || isControlId(frame.id)) return; // ignore the hello frame
          received[i]!.push(bytes);
          if (received[i]!.length === M) resolve();
        };
      });
      return { opened, done };
    });

    // all subscribers connected first...
    await Promise.all(clients.map((c) => c.opened));
    // ...then publish (the `done` promises resolve as frames arrive)
    for (let i = 0; i < M; i++) {
      server.publish("complex", {
        id: `c${i}`,
        names: [`n${i}`],
        prices: [i, i + 0.5],
        counts: [i],
        flags: [i % 2 === 0],
        tags: ["hot", "new"],
        active: true,
        total: i,
        ts: i,
      });
    }
    await Promise.all(clients.map((c) => c.done));

    // every subscriber got every frame, byte-identical to subscriber 0's copy
    for (let i = 0; i < N; i++) expect(received[i]!.length).toBe(M);
    for (let i = 0; i < M; i++) {
      for (let c = 1; c < N; c++) {
        expect(received[c]![i]!.byteLength).toBe(received[0]![i]!.byteLength);
        expect(received[c]![i]!.every((b, j) => b === received[0]![i]![j])).toBe(true);
      }
      // and the frame decodes to the payload that was published
      const dec = decodeFrame(received[0]![i]!);
      expect(dec!.name).toBe("complex");
      expect((dec!.payload as Events["complex"]).id).toBe(`c${i}`);
    }

    for (const ws of sockets) ws.close();
    server.stop();
  }, 15000);
});
