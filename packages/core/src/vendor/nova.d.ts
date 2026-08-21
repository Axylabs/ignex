/**
 * Ambient type surface for the `@ignex/nova` realtime transport.
 *
 * This is the SUB-SET of nova's API that ignex consumes (the `novaPlugin`
 * bridge + the `@ignex/nova/events` facade). It is mapped through the root
 * tsconfig `paths`, so TypeScript resolves the module even when the package
 * isn't installed; at runtime `novaPlugin` loads the REAL package lazily
 * (`import("@ignex/nova/server")`). Keeping a trimmed, hand-maintained
 * surface here mirrors the `castrum` vendor pattern and avoids type-checking
 * nova's published `.ts` source under this repo's stricter flags
 * (`exactOptionalPropertyTypes`), which the package doesn't yet satisfy.
 */

/** Identity metadata nova attaches to a connected client. */
export interface ClientMeta {
  /** Stable client id. */
  id?: string;
  /** The user this connection acts on behalf of. */
  userId?: string;
  /** Seed client groups. */
  groups?: string[];
  /** Arbitrary app metadata. */
  meta?: Record<string, unknown>;
}

/** What the nova `authenticate` hook may return. */
export type AuthResult = boolean | ClientMeta;

/** The server surface `novaPlugin` drives. */
export interface IgnServer {
  readonly port: number;
  publish(name: string, payload: unknown): void;
  publishTo(ws: unknown, name: string, payload: unknown): void;
  publishToClient(id: string, name: string, payload: unknown): void;
  publishToTopic(topic: string, name: string, payload: unknown): void;
  publishToGroup(group: string, name: string, payload: unknown): void;
  joinGroup(clientId: string, group: string): void;
  getClients(): unknown[];
  getMetrics(): unknown;
  drain(timeoutMs?: number): Promise<void>;
  stop(force?: boolean): void;
}

/** Options accepted by nova's `createServer`. */
export interface IgnServerOptions {
  port: number;
  hostname?: string;
  path?: string;
  idleTimeout?: number;
  bindings?: unknown;
  inbound?: readonly string[];
  backpressure?: unknown;
  replay?: { historySize?: number };
  authenticate?: (req: Request) => AuthResult | Promise<AuthResult>;
  allowedOrigins?: readonly string[];
  token?: string | ((token: string) => boolean);
  maxConnections?: number;
  maxMessageSize?: number;
  tls?: Bun.ServeOptions<unknown>["tls"];
  nats?: unknown;
  events?: unknown;
  fetch?: (req: Request) => Response | Promise<Response>;
}

declare const _createServer: (options: IgnServerOptions) => IgnServer;

export { _createServer as createServer };
