/**
 * Flux Core Unified Type System
 *
 * AOT upgrade:
 * - ContextUsage now comes from shared
 * - keeps runtime schema/lifecycle/server types
 */

import type { ContextUsage } from "@flux/shared";
import { EMPTY_USAGE, FULL_USAGE } from "@flux/shared";

export type { ContextUsage };
export { EMPTY_USAGE, FULL_USAGE };

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "ALL",
  "WS",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export type MaybePromise<T> = T | Promise<T>;
export type MaybeArray<T> = T | T[];
export type MaybeReadonlyArray<T> = T | readonly T[];

export type Prettify<T> = { [K in keyof T]: T[K] } & {};
export type IsAny<T> = 0 extends 1 & T ? true : false;
export type IsNever<T> = [T] extends [never] ? true : false;

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown
    ) => MaybePromise<{ value: Output } | { issues: readonly SchemaIssue[] }>;
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}

export interface SchemaIssue {
  readonly message: string;
  readonly path?: readonly (string | number)[];
}

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
  elysiaMeta?: string;
}

export type AnySchema = TSchema | StandardSchemaV1;

export type Static<T extends AnySchema> =
  T extends StandardSchemaV1<any, infer O>
    ? O
    : T extends TSchema
      ? T["static"]
      : unknown;

export interface RouteSchema {
  body?: unknown;
  headers?: unknown;
  query?: unknown;
  params?: unknown;
  cookie?: unknown;
  response?: unknown;
}

export interface InputSchema<Name extends string = string> {
  body?: AnySchema | Name;
  headers?: AnySchema | Name;
  query?: AnySchema | Name;
  params?: AnySchema | Name;
  cookie?: AnySchema | Name;
  response?: { [status: number]: AnySchema | Name };
}

export type LifeCycleType = "global" | "scoped" | "local";

export interface HookContainer<T = Function> {
  fn: T;
  scope?: LifeCycleType;
  subType?: string;
  checksum?: number;
  isAsync?: boolean;
  hasReturn?: boolean;
}

export interface LifeCycleStore {
  start: HookContainer[];
  request: HookContainer[];
  parse: HookContainer[];
  transform: HookContainer[];
  beforeHandle: HookContainer[];
  afterHandle: HookContainer[];
  mapResponse: HookContainer[];
  afterResponse: HookContainer[];
  trace: HookContainer[];
  error: HookContainer[];
  stop: HookContainer[];
}

export const EMPTY_LIFECYCLE: LifeCycleStore = {
  start: [],
  request: [],
  parse: [],
  transform: [],
  beforeHandle: [],
  afterHandle: [],
  mapResponse: [],
  afterResponse: [],
  trace: [],
  error: [],
  stop: [],
};

export interface SingletonBase {
  decorator: Record<string, unknown>;
  store: Record<string, unknown>;
  derive: Record<string, unknown>;
  resolve: Record<string, unknown>;
}

export interface DefinitionBase {
  type: Record<string, AnySchema>;
  error: Record<string, Error>;
}

export interface RouteConfig {
  cache?:
    | number
    | { maxAge?: number; swr?: number; immutable?: boolean; vary?: string[] };
  headers?: Record<string, string>;
  hooks?: string[];
  mount?: (req: Request) => MaybePromise<Response>;
}

export interface DocumentDecoration {
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  security?: Record<string, string[]>[];
  [key: string]: unknown;
}

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
  secrets?: string | null | (string | null)[];
}

export interface ElysiaCookie extends CookieOptions {
  value?: unknown;
}

export interface ServerOptions {
  port?: number | string;
  hostname?: string;
  reusePort?: boolean;
  development?: boolean;
  maxRequestBodySize?: number;
  idleTimeout?: number;
  routes?: Record<
    string,
    Function | Response | Record<string, Function | Response>
  >;
  websocket?: WebSocketHandler;
}

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
  perMessageDeflate?:
    | boolean
    | { compress?: boolean | string; decompress?: boolean | string };
}

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

