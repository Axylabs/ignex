/**
 * Ambient type surface for the OPTIONAL `@ignex/nova` realtime transport
 * (external ignex-nova repo, `bun link`-ed in full local-dev setups; registry
 * semver is the manifest default). Mapped through the root tsconfig `paths`
 * (mirrors the nodemailer / ioredis / ninox vendor pattern), so TypeScript
 * resolves the module even when the repo isn't installed.
 *
 * This file only needs to cover what ignex itself imports/consumes:
 *   - `@ignex/nova/server`  — the nova Bun server factory (`novaPlugin`).
 *   - `@ignex/nova/events`  — the typed events facade (loaded dynamically).
 *   - `@ignex/nova/client`  — the typed FlatBuffer client (verify script).
 * Real integration code casts to its own structural contracts, so the surface
 * here stays intentionally loose.
 */

declare module "@ignex/nova/server" {
  /** Start a nova realtime server (Bun WebSockets + FlatBuffer frames). */
  export function createServer(options: unknown): unknown;
}

declare module "@ignex/nova/events" {
  /** The typed events facade (emit / emitToUser / on / …). */
  export const events: unknown;
}

declare module "@ignex/nova/client" {
  /** Typed FlatBuffer realtime client (server bindings resolved by the app). */
  export interface NovaClient {
    on(event: string, handler: (payload: unknown) => void): void;
    onStatus(handler: (status: string) => void): void;
    connect(): void;
    disconnect(): void;
    close(): void;
    send(event: string, payload: unknown): void;
    [method: string]: unknown;
  }

  /** Connect a typed client to `ws://…` (or `wss://…`). */
  export function createClient(url: string): NovaClient;
}
