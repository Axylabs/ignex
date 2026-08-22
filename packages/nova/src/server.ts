/**
 * Runnable demo server.
 *
 *   bun run serve   (after: bun run generate && cargo build --release && bun run build:client)
 *
 * Serves:
 *   - /ws      → websocket (typed pub/sub events)
 *   - /health  → health check
 *   - /        → client/index.html + /dist/* from client-dist/ (browser demo)
 */
import { join } from "node:path";
import { createServer } from "../public/server";

const here = import.meta.dir;
const CLIENT_DIR = join(here, "..", "client");
const DIST_DIR = join(here, "..", "client-dist");

const port = Number(process.env.PORT ?? 3000);
const natsUrl = process.env.NATS_URL;
const server = createServer({
  port,
  ...(natsUrl ? { nats: { servers: [natsUrl], inbound: true } } : {}),
  fetch: (req) => serveStatic(req),
});

console.log(`ignex demo: http://localhost:${port}/  (ws: ws://localhost:${port}/ws)`);
if (natsUrl) {
  console.log(
    `ignex demo: NATS bridge → ${natsUrl} (subjects: ignex.broadcast.* / ignex.topic.* / ignex.group.*; inbound: ignex.inbound.>)`,
  );
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

async function serveStatic(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = rel.startsWith("/dist/")
    ? join(DIST_DIR, rel.slice("/dist/".length))
    : join(CLIENT_DIR, rel);
  const f = Bun.file(file);
  if (!(await f.exists())) return new Response("not found", { status: 404 });
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
  return new Response(f, {
    headers: { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" },
  });
}

// Static page + pub/sub websocket share one port: /ws is upgraded by the
// event server, everything else falls through to the static file handler.

// ── push synthetic market data ─────────────────────────────────────────
let seq = 0;
setInterval(() => {
  seq++;
  server.publish("quote", {
    symbol: "AAPL",
    bid: 180 + Math.sin(seq / 10) * 0.5,
    ask: 180.1 + Math.cos(seq / 10) * 0.5,
    bidSize: 100 + (seq % 400),
    askSize: 200 + (seq % 300),
    ts: Date.now(),
  });
  server.publish("trade", {
    symbol: seq % 2 === 0 ? "AAPL" : "MSFT",
    price: 180 + Math.random(),
    volume: 1 + (seq % 50),
    side: seq % 2 === 0 ? "buy" : "sell",
    ts: Date.now(),
  });
  if (seq % 5 === 0) {
    server.publish("portfolio", {
      accountId: "demo-1",
      positions: [
        { symbol: "AAPL", quantity: 100, avgPrice: 175, pnl: 500 + seq },
        { symbol: "MSFT", quantity: 50, avgPrice: 400, pnl: -120 + seq },
      ],
      totalValue: 18000 + seq,
      cash: 2500,
      ts: Date.now(),
      updatedBy: "ignex-demo",
    });
  }
}, 0);
