#!/usr/bin/env bun

const url = process.argv[2] || "http://localhost:3000/health";
const durationMs = Number(process.env.DURATION ?? 10) * 1000;
const concurrency = Number(process.env.CONCURRENCY ?? 100);

let count = 0;
let errors = 0;

const latencies: number[] = [];

async function worker() {
  const end = Date.now() + durationMs;

  while (Date.now() < end) {
    const start = performance.now();

    try {
      const res = await fetch(url);
      await res.arrayBuffer();

      count++;
      latencies.push(performance.now() - start);
    } catch {
      errors++;
    }
  }
}

console.log(`Benchmarking ${url}`);
console.log(`concurrency=${concurrency} duration=${durationMs / 1000}s`);

await Promise.all(Array.from({ length: concurrency }, () => worker()));

latencies.sort((a, b) => a - b);

const avg = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;

const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
const p99 = latencies[Math.floor(latencies.length * 0.99)] ?? 0;

console.log("\nSummary:");
console.log(`requests: ${count}`);
console.log(`errors: ${errors}`);
console.log(`requests/sec: ${(count / (durationMs / 1000)).toFixed(2)}`);
console.log(`latency avg: ${avg.toFixed(2)}ms`);
console.log(`latency p50: ${p50.toFixed(2)}ms`);
console.log(`latency p95: ${p95.toFixed(2)}ms`);
console.log(`latency p99: ${p99.toFixed(2)}ms`);

export {};
