/**
 * Browser demo — consumes the public client API only. No FlatBuffer code, no
 * Rust, no FFI. Bundle with `bun run build:client` (`bun build --target=browser`).
 */
import { createClient } from "../public/client";
import type { Events } from "../src/schema";

const client = createClient(`ws://${location.host}/ws`);

const statusEl = document.getElementById("status")!;
const quotesEl = document.getElementById("quotes")!;
const tradesEl = document.getElementById("trades")!;
const portfolioEl = document.getElementById("portfolio")!;

let count = 0;

client.on("quote", (q: Events["quote"]) => {
  quotesEl.textContent = `${q.symbol}  bid ${q.bid.toFixed(2)} · ask ${q.ask.toFixed(2)}  @ ${new Date(q.ts).toISOString()}`;
  statusEl.textContent = `connected · ${++count} events`;
});

client.on("trade", (t: Events["trade"]) => {
  tradesEl.textContent = `${t.side.toUpperCase()} ${t.symbol}  ${t.volume} @ ${t.price.toFixed(2)}  @ ${new Date(t.ts).toISOString()}`;
});

client.on("portfolio", (p: Events["portfolio"]) => {
  const rows = p.positions
    .map((x) => `${x.symbol} ×${x.quantity} pnl ${x.pnl.toFixed(2)}`)
    .join(" · ");
  portfolioEl.textContent = `${p.positions.length} positions [${rows}] · total ${p.totalValue.toFixed(2)} · cash ${p.cash.toFixed(2)}`;
});

client.connect();
