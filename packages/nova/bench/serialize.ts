/**
 * Serialize latency: Rust FFI path vs a JS-side flatc builder baseline.
 * Requires: `bun run generate` + `cargo build --release`.
 *
 *   bun run bench:serialize
 */
import * as flatbuffers from "flatbuffers";
import { PortfolioPositionT, PortfolioSnapshotT, TradeT } from "../src/generated/ts/backend";
import type { Events } from "../src/schema";
import { encodeEvent, encodeToScratch } from "../src/transport/transport";
import { measureNs } from "./measure";

const quote: Events["quote"] = {
  symbol: "AAPL",
  bid: 180.25,
  ask: 180.3,
  bidSize: 100,
  askSize: 200,
  ts: 1720000000000,
};

const portfolio: Events["portfolio"] = {
  accountId: "acc-1",
  positions: [
    { symbol: "AAPL", quantity: 100, avgPrice: 175, pnl: 500.5 },
    { symbol: "MSFT", quantity: 50, avgPrice: 400, pnl: -120 },
    { symbol: "NVDA", quantity: 25, avgPrice: 900, pnl: 1200 },
  ],
  totalValue: 18000,
  cash: 2500,
  ts: 1720000000000,
  updatedBy: "bench",
};

// warm the FFI bind
encodeEvent("quote", quote);

const rustQuoteNs = measureNs(() => encodeEvent("quote", quote));
const rustQuoteScratchNs = measureNs(() => encodeToScratch("quote", quote));
const rustPortfolioNs = measureNs(() => encodeEvent("portfolio", portfolio));
const _jsonNs = measureNs(() => JSON.stringify(quote));
const _jsonPortfolioNs = measureNs(() => JSON.stringify(portfolio));

/** heap delta per op after forcing GC — measures per-call allocations. */
function measureAlloc(fn: () => void, runs = 200_000): number {
  Bun.gc(true);
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < runs; i++) fn();
  Bun.gc(true);
  const after = process.memoryUsage().heapUsed;
  return (after - before) / runs;
}

const allocScratch = measureAlloc(() => encodeToScratch("quote", quote));
const allocEvent = measureAlloc(() => encodeEvent("quote", quote));

// JS-side flatc baseline (no JSON step — takes the object directly)
const builder = new flatbuffers.Builder(1024);
const tradeT = new TradeT("AAPL", 180.5, 10n, 0, 1720000000000n);
const jsTradeNs = measureNs(() => {
  builder.clear();
  const off = tradeT.pack(builder);
  builder.finishSizePrefixed(off);
  void builder.asUint8Array();
});

const portfolioT = new PortfolioSnapshotT(
  "acc-1",
  [
    new PortfolioPositionT("AAPL", 100n, 175, 500.5),
    new PortfolioPositionT("MSFT", 50n, 400, -120),
    new PortfolioPositionT("NVDA", 25n, 900, 1200),
  ],
  18000,
  2500,
  1720000000000n,
  "bench",
);
const jsPortfolioNs = measureNs(() => {
  builder.clear();
  const off = portfolioT.pack(builder);
  builder.finishSizePrefixed(off);
  void builder.asUint8Array();
});

// Large payload: 200 positions — this is where per-field JS builder costs scale.
const bigPositions = Array.from({ length: 200 }, (_, i) => ({
  symbol: `SYM${i}`,
  quantity: i + 1,
  avgPrice: 100 + i * 0.5,
  pnl: (i % 100) - 50,
}));
const bigPortfolio: Events["portfolio"] = {
  accountId: "big-acc",
  positions: bigPositions,
  totalValue: 1_000_000,
  cash: 10_000,
  ts: 1720000000000,
  updatedBy: "bench",
};

const rustBigNs = measureNs(() => encodeEvent("portfolio", bigPortfolio));
const _jsonBigNs = measureNs(() => JSON.stringify(bigPortfolio));

const bigT = new PortfolioSnapshotT(
  "big-acc",
  bigPositions.map((p) => new PortfolioPositionT(p.symbol, BigInt(p.quantity), p.avgPrice, p.pnl)),
  1_000_000,
  10_000,
  1720000000000n,
  "bench",
);
const jsBigNs = measureNs(() => {
  builder.clear();
  const off = bigT.pack(builder);
  builder.finishSizePrefixed(off);
  void builder.asUint8Array();
});

console.log("serialize latency (min-of-N ns/op):");
console.log(
  `  quote     Rust FFI ZERO-ALLOC       : ${rustQuoteScratchNs.toFixed(1).padStart(8)} ns   (encodeToScratch, no JSON)`,
);
console.log(
  `  quote     Rust FFI (owned copy)     : ${rustQuoteNs.toFixed(1).padStart(8)} ns   (encodeEvent incl. 1 alloc)`,
);
console.log(`  quote     JS-side flatc pack        : ${jsTradeNs.toFixed(1).padStart(8)} ns`);
console.log(
  `  portfolio Rust FFI (packed vector)  : ${rustPortfolioNs.toFixed(1).padStart(8)} ns   (no JSON)`,
);
console.log(`  portfolio JS-side flatc pack        : ${jsPortfolioNs.toFixed(1).padStart(8)} ns`);
console.log(
  `  LARGE     Rust FFI (packed vector)  : ${rustBigNs.toFixed(1).padStart(8)} ns   (200 positions, no JSON)`,
);
console.log(`  LARGE     JS-side flatc pack        : ${jsBigNs.toFixed(1).padStart(8)} ns`);
console.log("");
console.log("allocations (heap delta/op, after GC):");
console.log(`  quote encodeToScratch (zero-alloc)  : ${allocScratch.toFixed(1).padStart(8)} B/op`);
console.log(`  quote encodeEvent (owned copy)      : ${allocEvent.toFixed(1).padStart(8)} B/op`);
console.log(
  `  quote speedup (zero-alloc vs JS)    : ${(jsTradeNs / rustQuoteScratchNs).toFixed(2)}×`,
);
console.log(
  `  portfolio speedup (Rust vs JS)      : ${(jsPortfolioNs / rustPortfolioNs).toFixed(2)}×`,
);
console.log(`  LARGE speedup (Rust vs JS)          : ${(jsBigNs / rustBigNs).toFixed(2)}×`);
