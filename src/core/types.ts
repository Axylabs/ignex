/**
 * @fileoverview Flux Core v3.0 — Unified Type System
 * Zero-runtime-cost types. All contracts are compile-time only.
 * Supports TypeBox, Standard Schema v1, and custom validators.
 */

// ============================================================================
// HTTP Primitives
// ============================================================================

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ALL", "WS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export type MaybePromise<T> = T | Promise<T>;
export type MaybeArray<T> = T | T[];
export type MaybeReadonlyArray<T> = T | readonly T[];
export type Prettify<T> = { [K in keyof T]: T[K] } & {};
export type IsAny<T> = 0 extends 1 & T ? true : false;
export type IsNever<T> = [T] extends [never] ? true : false;

// ============================================================================
// Schema Contracts (Standard Schema v1 + TypeBox compatible)
// ============================================================================

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
export type Static<T extends AnySchema> = T extends StandardSchemaV1<any, infer O> ? O : T extends TSchema ? T["static"] : unknown;

// ============================================================================
// Route Schema
// ============================================================================

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

// ============================================================================
// Context Usage (Build-time inference)
// ============================================================================

export interface ContextUsage {
  body: boolean;
  params: boolean;
  query: boolean;
  file: boolean;
  headers: boolean;
  state: boolean;
  json: boolean;
  text: boolean;
  html: boolean;
  redirect: boolean;
  stream: boolean;
  req: boolean;
  url: boolean;
  cookie: boolean;
  server: boolean;
  set: boolean;
}

export const EMPTY_USAGE: ContextUsage = {
  body: false, params: false, query: false, file: false,
  headers: false, state: false, json: false, text: false,
  html: false, redirect: false, stream: false, req: false,
  url: false, cookie: false, server: false, set: false,
};

export const FULL_USAGE: ContextUsage = {
  body: true, params: true, query: true, file: true,
  headers: true, state: true, json: true, text: true,
  html: true, redirect: true, stream: true, req: true,
  url: true, cookie: true, server: true, set: true,
};

// ============================================================================
// Lifecycle Types
// ============================================================================

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
  start: [], request: [], parse: [], transform: [],
  beforeHandle: [], afterHandle: [], mapResponse: [],
  afterResponse: [], trace: [], error: [], stop: [],
};

// ============================================================================
// Singleton & Definitions
// ============================================================================

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

// ============================================================================
// Route Configuration
// ============================================================================

export interface RouteConfig {
  cache?: number | { maxAge?: number; swr?: number; immutable?: boolean; vary?: string[] };
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

// ============================================================================
// Cookie Types
// ============================================================================

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

// ============================================================================
// Server Types
// ============================================================================

export interface ServerOptions {
  port?: number | string;
  hostname?: string;
  reusePort?: boolean;
  development?: boolean;
  maxRequestBodySize?: number;
  idleTimeout?: number;
  routes?: Record<string, Function | Response | Record<string, Function | Response>>;
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
  perMessageDeflate?: boolean | { compress?: boolean | string; decompress?: boolean | string };
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

// ============================================================================
// Compiler Options
// ============================================================================

export interface CompilerOptions {
  readonly routesDir: string;
  readonly outDir: string;
  readonly outFile: string;
  readonly target: "bun" | "node" | "deno";
  readonly optimizationLevel: 0 | 1 | 2 | 3;
  readonly inlineThreshold: number;
  readonly enableSchemaInlining: boolean;
  readonly enableResponsePreserialization: boolean;
  readonly sourceMap: boolean;
  readonly minify: boolean;
  readonly enableTracing: boolean;
  readonly enableAccessLog: boolean;
  readonly enableLifecycle: boolean;
  readonly enableStrictMethods: boolean;
  readonly serviceName: string;
  readonly requestIdHeader: string;
  readonly exposeErrorDetails: boolean;
  readonly maxJsonBytes: number;
  readonly maxTextBytes: number;
  readonly maxFormBytes: number;
  readonly maxFileBytes: number;
  readonly hooksDir?: string;
  readonly cluster?: number | "auto";
  readonly reusePort?: boolean;
}

export const DEFAULT_OPTS: CompilerOptions = {
  routesDir: "./src/routes",
  outDir: "./dist",
  outFile: "__server.js",
  target: "bun",
  optimizationLevel: 3,
  inlineThreshold: 50,
  enableSchemaInlining: true,
  enableResponsePreserialization: true,
  sourceMap: false,
  minify: false,
  enableTracing: true,
  enableAccessLog: true,
  enableLifecycle: true,
  enableStrictMethods: true,
  serviceName: "flux",
  requestIdHeader: "x-request-id",
  exposeErrorDetails: process.env.NODE_ENV !== "production",
  maxJsonBytes: 2 * 1024 * 1024,
  maxTextBytes: 2 * 1024 * 1024,
  maxFormBytes: 2 * 1024 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
};