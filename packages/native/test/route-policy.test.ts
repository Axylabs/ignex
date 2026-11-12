/**
 * Unit tests for the adaptive route execution policy
 * (`createRouteExecutionPolicy` — the cost model behind the compiler's
 * `nativeRoutesAdaptive` option). All timing is injected (`nowNs`), so the
 * sampled-EWMA learning, bootstrap, bounded exploration, and hysteresis are
 * deterministic here — no real clocks, no addon required.
 */
import { describe, expect, it } from "vitest";
import { createNativeRouteRuntime } from "../src/route";
import { createRouteExecutionPolicy, type NativeRouteChoice } from "../src/route-policy";
import type { NativeRoutePlan, NativeRouteStage } from "../src/route-wire";

const planOf = (pipeline: NativeRouteStage[]): NativeRoutePlan => ({
  pipeline,
  schemas: {},
  maxBodyBytes: 1024,
  maxQueryBytes: 1024,
  maxCookieBytes: 1024,
  maxPairs: 0,
});

const isToken = (c: boolean | NativeRouteChoice): c is NativeRouteChoice => typeof c === "object";

describe("route execution policy — steady state", () => {
  it("returns bare booleans between samples and a token on the sampled tick", () => {
    let now = 0;
    const policy = createRouteExecutionPolicy(planOf(["parseQuery"]), {
      nowNs: () => (now += 1000),
      sampleEvery: 4,
    });
    // Small bucket prior for a query route is JS → steady state false.
    expect(policy.chooseExecution("a=1", "", null)).toBe(false);
    expect(policy.chooseExecution("a=1", "", null)).toBe(false);
    expect(policy.chooseExecution("a=1", "", null)).toBe(false);
    const fourth = policy.chooseExecution("a=1", "", null);
    expect(isToken(fourth)).toBe(true);
    if (isToken(fourth)) {
      // Bootstrap: the unmeasured mode (JS here) is probed first. The clock
      // only fires on sampled ticks, so `start` is its FIRST reading.
      expect(fourth.native).toBe(false);
      expect(fourth.bucket).toBe(0);
      expect(fourth.start).toBe(1000);
    }
  });

  it("splits buckets at the byte threshold (511 → small, 512 → large)", () => {
    let now = 0;
    const policy = createRouteExecutionPolicy(planOf(["parseQuery"]), {
      nowNs: () => (now += 1000),
      sampleEvery: 2,
    });
    // Interleave sizes so each bucket hits its own 2nd tick simultaneously.
    policy.chooseExecution("a".repeat(511), "", null); // small tick 1
    policy.chooseExecution("a".repeat(512), "", null); // large tick 1
    const small = policy.chooseExecution("a".repeat(511), "", null); // small tick 2 → token
    const large = policy.chooseExecution("a".repeat(512), "", null); // large tick 2 → token
    expect(isToken(small) && small.bucket === 0).toBe(true);
    expect(isToken(large) && large.bucket === 1).toBe(true);
  });
});

describe("route execution policy — cold-start priors", () => {
  it("body-verdict routes start native at every size", () => {
    const policy = createRouteExecutionPolicy(planOf(["requireJsonBody", "validateBody"]), {
      nowNs: () => 1,
    });
    expect(policy.chooseExecution("", "", new Uint8Array(8))).toBe(true);
    expect(policy.chooseExecution("", "", new Uint8Array(4096))).toBe(true);
  });

  it("query routes start JS small, native large", () => {
    const policy = createRouteExecutionPolicy(planOf(["parseQuery"]), { nowNs: () => 1 });
    expect(policy.chooseExecution("a=1", "", null)).toBe(false);
    expect(policy.chooseExecution("a".repeat(600), "", null)).toBe(true);
  });

  it("cookie-only routes start JS at every size", () => {
    const policy = createRouteExecutionPolicy(planOf(["parseCookies"]), { nowNs: () => 1 });
    expect(policy.chooseExecution("", "sid=1", null)).toBe(false);
    expect(policy.chooseExecution("", `sid=${"x".repeat(600)}`, null)).toBe(false);
  });
});

describe("route execution policy — learning", () => {
  /** Drive one large-bucket sampled lifecycle with alpha=1 (EWMA = last
   *  sample) so every recorded duration deterministically replaces the last. */
  const learnedPolicy = (plan: NativeRoutePlan) => {
    let now = 0;
    const body = new Uint8Array(1024); // always the large bucket
    const policy = createRouteExecutionPolicy(plan, {
      nowNs: () => (now += 1000),
      sampleEvery: 2,
      minSamples: 2,
      exploreEvery: 2,
      ewmaAlpha: 1,
      hysteresis: 0.1,
    });
    /** One request; `nativeNs`/`fallbackNs` is the duration recorded when the
     *  tick is sampled (bootstrap/explore decides which mode runs). */
    const step = (nativeNs: number, fallbackNs: number): boolean | NativeRouteChoice => {
      const choice = policy.chooseExecution("a=1", "", body);
      if (isToken(choice)) {
        policy.recordExecution(choice, choice.start + (choice.native ? nativeNs : fallbackNs));
      }
      return choice;
    };
    return { policy, step };
  };

  it("bootstraps both modes, then flips when native regresses under load", () => {
    // Query plan → large bucket starts native.
    const { policy, step } = learnedPolicy(planOf(["parseQuery"]));
    // Query plan → large bucket starts native. Bootstrap (sampled ticks 2,
    // 4, 6, 8): fallback @1000ns twice, then native @100ns twice.
    for (let i = 0; i < 8; i++) step(100, 1000);
    expect(policy.snapshot()[1]).toMatchObject({
      preferNative: true,
      nativeSamples: 2,
      fallbackSamples: 2,
    });
    // Post-bootstrap: tick 10 is the preferred native, tick 12 explores the
    // fallback — the 100ns native EWMA holds the preference.
    for (let i = 0; i < 4; i++) step(100, 1000);
    expect(policy.snapshot()[1].preferNative).toBe(true);
    // Load shift: native now costs 5000ns. Tick 13 is an unsampled steady
    // state (no record); the next SAMPLED request is preferred-native, its
    // record rewrites the native EWMA to 5000 → JS (1000) is >10% faster →
    // the preference flips AFTER that decision.
    expect(step(5000, 1000)).toBe(true);
    const flipped = step(5000, 1000);
    expect(isToken(flipped) && flipped.native).toBe(true);
    expect(policy.snapshot()[1].preferNative).toBe(false);
    // Steady state now routes JS without sampling.
    expect(step(5000, 1000)).toBe(false);
  });

  it("holds the preference inside the hysteresis band (8% advantage flips nothing)", () => {
    // Cookie-only plan → large bucket starts JS. Bootstrap probes native at
    // 920ns vs the fallback's 1000ns — an 8% lead, inside the 10% band.
    const { policy, step } = learnedPolicy(planOf(["parseCookies"]));
    for (let i = 0; i < 8; i++) step(920, 1000);
    expect(policy.snapshot()[1]).toMatchObject({
      preferNative: false,
      nativeSamples: 2,
      fallbackSamples: 2,
    });
  });

  it("flips once a mode leads beyond the band (15% advantage)", () => {
    const { policy, step } = learnedPolicy(planOf(["parseCookies"]));
    for (let i = 0; i < 8; i++) step(850, 1000);
    expect(policy.snapshot()[1]).toMatchObject({
      preferNative: true,
      nativeSamples: 2,
      fallbackSamples: 2,
    });
  });

  it("ignores non-monotonic clock samples", () => {
    let now = 0;
    const policy = createRouteExecutionPolicy(planOf(["parseQuery"]), {
      nowNs: () => (now += 1000),
      sampleEvery: 2,
    });
    policy.chooseExecution("a=1", "", new Uint8Array(1024));
    const token = policy.chooseExecution("a=1", "", new Uint8Array(1024));
    if (!isToken(token)) throw new Error("expected a sampled token");
    policy.recordExecution(token, token.start - 5);
    expect(policy.snapshot()[1].nativeSamples).toBe(0);
    expect(policy.snapshot()[1].fallbackSamples).toBe(0);
  });
});

describe("route runtime wiring", () => {
  it("exposes the policy on the compiled route (choose → record → snapshot)", () => {
    const route = createNativeRouteRuntime(
      {
        run() {
          return 0;
        },
        runParts() {
          return 0;
        },
        destroy() {},
      },
      planOf(["parseQuery"]),
    );
    // Default cadence (1/64): first call is a bare prior boolean. Note the
    // second call lands in the LARGE bucket (1024-byte body), so the small
    // bucket needs 63 more calls to reach its own 64th tick.
    expect(route.chooseExecution("a=1", "", null)).toBe(false);
    expect(route.chooseExecution("", "", new Uint8Array(1024))).toBe(true);
    let sampled: boolean | NativeRouteChoice = false;
    for (let i = 0; i < 63; i++) sampled = route.chooseExecution("a=1", "", null);
    expect(isToken(sampled)).toBe(true);
    if (isToken(sampled)) {
      route.recordExecution(sampled, sampled.start + 250);
      expect(route.policySnapshot()[0].fallbackSamples).toBe(1);
    }
    route.destroy();
  });
});
