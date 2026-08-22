/**
 * TypeBox schema — the SINGLE SOURCE OF TRUTH for the wire format.
 *
 * Everything else is generated from here:
 *   - `scripts/generate.ts` → backend.fbs → flatc --ts (browser decoders) +
 *     Rust glue (`rust/src/transcode/generated.rs`) + `src/generated/registry.ts`.
 *
 * The `events` registry defines the pub/sub event surface. Each event maps to
 * a TypeBox schema; `Events[K]` is the plain-object type devs see on both the
 * server (publish) and the FE (on) — no FlatBuffer API anywhere in sight.
 */
import { type Static, Type } from "@sinclair/typebox";

// ── Enums (union of string literals → FlatBuffer enum) ───────────────
export const Side = Type.Union([Type.Literal("buy"), Type.Literal("sell")]);

// ── Realtime market-data payloads ─────────────────────────────────────
export const Trade = Type.Object(
  {
    symbol: Type.String(),
    price: Type.Number(), // double
    volume: Type.Integer(), // int64
    side: Side, // enum
    ts: Type.Integer(), // int64
  },
  { additionalProperties: false },
);

export const Quote = Type.Object(
  {
    symbol: Type.String(),
    bid: Type.Number(),
    ask: Type.Number(),
    bidSize: Type.Integer(),
    askSize: Type.Integer(),
    ts: Type.Integer(),
  },
  { additionalProperties: false },
);

export const PortfolioPosition = Type.Object(
  {
    symbol: Type.String(),
    quantity: Type.Integer(),
    avgPrice: Type.Number(),
    pnl: Type.Number(),
  },
  { additionalProperties: false },
);

export const PortfolioSnapshot = Type.Object(
  {
    accountId: Type.String(),
    positions: Type.Array(PortfolioPosition), // vector of tables
    totalValue: Type.Number(),
    cash: Type.Number(),
    ts: Type.Integer(),
    updatedBy: Type.Optional(Type.String()), // optional string
  },
  { additionalProperties: false },
);

// ── Complex / nested payloads (integrity + nesting coverage) ──────────
export const Tag = Type.Union([Type.Literal("hot"), Type.Literal("new"), Type.Literal("sale")]);

/** Every packed-vector kind + scalars on ONE flat event (DIRECT fast path). */
export const Complex = Type.Object(
  {
    id: Type.String(),
    names: Type.Array(Type.String()), // vector-string
    prices: Type.Array(Type.Number()), // vector-double
    counts: Type.Array(Type.Integer()), // vector-int64
    flags: Type.Array(Type.Boolean()), // vector-bool
    tags: Type.Array(Tag), // vector-enum
    active: Type.Boolean(),
    total: Type.Number(),
    ts: Type.Integer(),
  },
  { additionalProperties: false },
);

/** Nested single-object table (forces the JSON fallback path in `order`). */
export const Customer = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    vip: Type.Boolean(),
    loyaltyPoints: Type.Integer(),
    rating: Type.Number(),
  },
  { additionalProperties: false },
);

/** Table element with its own vector (deep nesting — not "flat"). */
export const OrderLine = Type.Object(
  {
    sku: Type.String(),
    qty: Type.Integer(),
    unitPrice: Type.Number(),
    tags: Type.Array(Tag), // vector-enum inside a table element
  },
  { additionalProperties: false },
);

/** Deeply nested event: single-object table, optional table, table-of-tables. */
export const Order = Type.Object(
  {
    orderId: Type.String(),
    customer: Customer, // nested single-object table
    lines: Type.Array(OrderLine), // vector of tables (each with a vector-enum)
    notes: Type.Array(Type.String()), // vector-string
    discounts: Type.Array(Type.Number()), // vector-double
    active: Type.Boolean(),
    createdAt: Type.Integer(),
    billing: Type.Optional(Customer), // optional nested table
  },
  { additionalProperties: false },
);

/**
 * An event with an EXACT int64 field: `Type.Integer({ bigint: true })` makes
 * the field decode/encode as `bigint` on both sides, so values above 2^53
 * round-trip losslessly (plain `number` int64s silently lose precision there).
 */
export const BigVal = Type.Object(
  {
    id: Type.String(),
    seq: Type.BigInt(), // exact int64 — survives beyond 2^53 (maps to `long` on the wire)
    when: Type.Integer(), // plain number (safe-integer timestamps)
  },
  { additionalProperties: false },
);

// ── Named schemas (referenced tables / enums) ────────────────────────
export const schemas = {
  Trade,
  Quote,
  PortfolioPosition,
  PortfolioSnapshot,
  Complex,
  Customer,
  OrderLine,
  Order,
  BigVal,
} as const;

// ── Event registry (source of truth for event ids + public API types) ─
export const events = {
  quote: Quote,
  trade: Trade,
  portfolio: PortfolioSnapshot,
  complex: Complex, // DIRECT path — all packed-vector kinds
  order: Order, // JSON fallback path — nested single-object tables
  bigVal: BigVal, // DIRECT path — exact bigint int64 field
} as const;

// ── Control events (transport-internal — hidden from the public Events surface) ─
//
// These are first-class FlatBuffer tables so they ride the SAME codegen,
// self-tests, and wire envelope as app events. The server encodes them via the
// Rust FFI (direct path — all are flat/directable); the browser client encodes
// them via the generated JS encoder (ts-ser). The transport layers route
// control frames BEFORE user handlers.
//
// Rules enforced by the direct fast path (why fields are shaped like this):
//   - no optional scalars / optional vectors (direct path has no Option support
//     for them) — use required fields with a 0/[] sentinel
export const Hello = Type.Object(
  {
    version: Type.Integer(), // wire version the sender supports
    caps: Type.Array(Type.String()), // capabilities list ([] = none)
    lastSeq: Type.Integer(), // last sequence seen (0 = none)
  },
  { additionalProperties: false },
);

export const Subscribe = Type.Object({ topic: Type.String() }, { additionalProperties: false });

export const Unsubscribe = Type.Object({ topic: Type.String() }, { additionalProperties: false });

export const JoinGroup = Type.Object({ group: Type.String() }, { additionalProperties: false });

export const LeaveGroup = Type.Object({ group: Type.String() }, { additionalProperties: false });

export const SnapshotRequest = Type.Object(
  { topic: Type.String() },
  { additionalProperties: false },
);

export const Ping = Type.Object({ ts: Type.Integer() }, { additionalProperties: false });

export const Pong = Type.Object({ ts: Type.Integer() }, { additionalProperties: false });

/** Server→client identity assignment (sent right after `hello` on open). */
export const Welcome = Type.Object(
  {
    clientId: Type.String(), // the id assigned to this connection (auth metadata or UUID)
    groups: Type.Array(Type.String()), // server-side groups this client belongs to
  },
  { additionalProperties: false },
);

/** Transport-internal event registry (name → schema). Not part of Events[K]. */
export const controlEvents = {
  hello: Hello,
  welcome: Welcome,
  subscribe: Subscribe,
  unsubscribe: Unsubscribe,
  joinGroup: JoinGroup,
  leaveGroup: LeaveGroup,
  snapshotRequest: SnapshotRequest,
  ping: Ping,
  pong: Pong,
} as const;

export type EventName = keyof typeof events;
export type ControlEventName = keyof typeof controlEvents;
export type AnyEventName = EventName | ControlEventName;
export type Events = { [K in EventName]: Static<(typeof events)[K]> };
export type ControlEvents = { [K in ControlEventName]: Static<(typeof controlEvents)[K]> };
