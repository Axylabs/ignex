/**
 * @fileoverview Purity tests for `NatsEventTracker` event ids.
 *
 * Ids were `ev-<ts36>-<seq36>-<rand4>` where `<seq36>` came from a MODULE-LEVEL
 * `eventSeq` counter and `<rand4>` from `Math.random()` — so two trackers in
 * one process shared hidden counter state, and ids carried no real randomness
 * (a forged/guessed id was guessable). This suite pins: per-instance counters,
 * crypto-random suffixes, and opaque-format stability.
 */

import { describe, expect, it } from "vitest";
import { NatsEventTracker } from "../src/debug/nats-tracker.js";

/** The per-instance sequence segment of an event id (`ev-<ts36>-<seq36>-<rand>`). */
const seqOf = (id: string): string => {
  const parts = id.split("-");
  expect(parts.length).toBeGreaterThanOrEqual(4);
  return parts[2] as string;
};

describe("NatsEventTracker — instance-scoped event ids", () => {
  it("gives two trackers independent sequence counters", () => {
    const a = new NatsEventTracker({ connect: false });
    const b = new NatsEventTracker({ connect: false });
    a.record("out", "a.1", "x", null);
    b.record("out", "b.1", "x", null); // module counter would make this seq "2"
    a.record("out", "a.2", "x", null);
    b.record("out", "b.2", "x", null);

    const aIds = a.list().map((e) => e.id);
    const bIds = b.list().map((e) => e.id);
    expect(seqOf(aIds[0] as string)).toBe(seqOf(bIds[0] as string)); // both first ⇒ "1"
    expect(seqOf(aIds[1] as string)).toBe(seqOf(bIds[1] as string)); // both second ⇒ "2"
    expect(seqOf(aIds[1] as string)).not.toBe(seqOf(aIds[0] as string));
  });

  it("keeps 10 000 rapid events unique (counter + random suffix)", () => {
    const tracker = new NatsEventTracker({ connect: false, maxEvents: 20_000 });
    for (let i = 0; i < 10_000; i++) tracker.record("out", `s.${i}`, "p", null);
    const ids = tracker.list({ limit: 20_000 }).map((e) => e.id);
    expect(ids.length).toBe(10_000);
    expect(new Set(ids).size).toBe(10_000);
    // Sequence segments are 1..10000 with no gaps or repeats.
    const seqs = ids.map((id) => Number.parseInt(seqOf(id), 36));
    expect(new Set(seqs).size).toBe(10_000);
  });

  it("emits the opaque `ev-<time36>-<seq36>-<rand>` format", () => {
    const tracker = new NatsEventTracker({ connect: false });
    tracker.record("out", "a.b", "p", null);
    const id = tracker.list()[0]?.id as string;
    expect(id).toMatch(/^ev-[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/);
  });

  it("random suffixes differ across two trackers at equal ticks", () => {
    const a = new NatsEventTracker({ connect: false });
    const b = new NatsEventTracker({ connect: false });
    a.record("out", "a", "p", null);
    b.record("out", "b", "p", null);
    const aFirst = a.list()[0];
    const bFirst = b.list()[0];
    expect(aFirst?.id).toBeDefined();
    expect(bFirst?.id).toBeDefined();
    if (aFirst === undefined || bFirst === undefined) return;
    const aRand = aFirst.id.split("-").slice(3).join("-");
    const bRand = bFirst.id.split("-").slice(3).join("-");
    expect(aRand).not.toBe(bRand);
  });
});
