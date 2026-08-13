/**
 * @fileoverview HTTP domain types — request/response, schema, cookies and
 * websocket shapes. Re-exported through `./index` (the unified type umbrella).
 */

/** A value or a `Promise` of that value. */
export type MaybePromise<T> = T | Promise<T>;

// Shared method vocabulary (single source of truth in @ignex/shared).
export { HTTP_METHODS, type HttpMethod } from "@ignex/shared";

/**
 * The Standard Schema v1 interface — the validation interop standard ignex
 * accepts from schema libraries (TypeBox, Zod, Valibot, ArkType, …).
 *
 * @see https://github.com/standard-schema/standard-schema
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => MaybePromise<{ value: Output } | { issues: readonly SchemaIssue[] }>;
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}

/** A single validation issue reported by a {@link StandardSchemaV1} validator. */
export interface SchemaIssue {
  readonly message: string;
  readonly path?: readonly (string | number)[];
}

/**
 * The structural subset of JSON Schema ignex understands (TypeBox-compatible
 * shape) for route schemas, static types, and OpenAPI generation.
 */
export interface TSchema {
  [kind: string]: unknown;
  static?: unknown;
  type?: string;
  properties?: Record<string, TSchema>;
  items?: TSchema | TSchema[];
  anyOf?: TSchema[];
  oneOf?: TSchema[];
  allOf?: TSchema[];
  $ref?: string;
  $defs?: Record<string, TSchema>;
  default?: unknown;
  enum?: unknown[];
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  required?: string[];
  additionalProperties?: boolean | TSchema;
  noValidate?: boolean;
}

/** Any schema ignex accepts: a structural {@link TSchema} or Standard Schema. */
export type AnySchema = TSchema | StandardSchemaV1;

/**
 * The inferred TypeScript type of a schema: `StandardSchemaV1` output or a
 * `TSchema`'s `static` member, falling back to `unknown`.
 */
export type Static<T extends AnySchema> =
  T extends StandardSchemaV1<any, infer O> ? O : T extends TSchema ? T["static"] : unknown;

/**
 * Per-route validation schema: `body`/`headers`/`query`/`params`/`cookie`
 * inputs plus the `response` output. Each entry is an `AnySchema`.
 */
export interface RouteSchema {
  body?: unknown;
  headers?: unknown;
  query?: unknown;
  params?: unknown;
  cookie?: unknown;
  response?: unknown;
}

/**
 * Options controlling cookie serialization attributes.
 *
 * `sameSite` accepts `true`/`false` for lax/off plus the explicit levels.
 */
export interface CookieOptions {
  domain?: string;
  expires?: Date;
  httpOnly?: boolean;
  maxAge?: number;
  path?: string;
  priority?: "low" | "medium" | "high";
  partitioned?: boolean;
  sameSite?: true | false | "lax" | "strict" | "none";
  secure?: boolean;
}

/** A cookie value paired with its serialization options. */
export interface ElysiaCookie extends CookieOptions {
  value?: unknown;
}

/**
 * Websocket message handlers plus connection tuning options.
 *
 * `T` is the per-connection `data` payload type (see {@link ServerWebSocket}).
 */
export interface WebSocketHandler<T = undefined> {
  open?(ws: ServerWebSocket<T>): MaybePromise<void>;
  message?(ws: ServerWebSocket<T>, message: string | Buffer): MaybePromise<void>;
  drain?(ws: ServerWebSocket<T>): MaybePromise<void>;
  close?(ws: ServerWebSocket<T>, code: number, reason: string): MaybePromise<void>;
  ping?(ws: ServerWebSocket<T>, data: Buffer): MaybePromise<void>;
  pong?(ws: ServerWebSocket<T>, data: Buffer): MaybePromise<void>;
  maxPayloadLength?: number;
  backpressureLimit?: number;
  closeOnBackpressureLimit?: boolean;
  idleTimeout?: number;
  sendPings?: boolean;
  perMessageDeflate?: boolean | { compress?: boolean | string; decompress?: boolean | string };
}

/**
 * The websocket connection surface passed to {@link WebSocketHandler} callbacks.
 *
 * `T` is the per-connection data payload carried alongside the connection.
 */
export interface ServerWebSocket<T = undefined> {
  send(data: string | ArrayBuffer | Uint8Array, compress?: boolean): number;
  sendText(data: string, compress?: boolean): number;
  sendBinary(data: ArrayBuffer | Uint8Array, compress?: boolean): number;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(data?: string | ArrayBuffer): number;
  pong(data?: string | ArrayBuffer): number;
  publish(topic: string, data: string | ArrayBuffer, compress?: boolean): number;
  publishText(topic: string, data: string, compress?: boolean): number;
  publishBinary(topic: string, data: ArrayBuffer | Uint8Array, compress?: boolean): number;
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  isSubscribed(topic: string): boolean;
  readonly subscriptions: string[];
  cork<T>(callback: (ws: ServerWebSocket<T>) => T): T;
  readonly remoteAddress: string;
  readonly readyState: 0 | 1 | 2 | 3;
  binaryType?: "nodebuffer" | "arraybuffer" | "uint8array";
  data: T;
}
