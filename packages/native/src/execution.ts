/**
 * Unified execution API — a single, domain-grouped facade over every
 * `@ignus/native` operation. Each method is bound to the fastest implementation
 * (castrum native on Bun vs pure-TS fallback) per the selection table in
 * `./selection.ts`, so:
 *
 *  - Consumers import ONE object (`backend`) instead of reaching into the
 *    per-op wrapper modules or sprinkling `if (native) … else …` themselves.
 *  - Changing which implementation wins is a one-line edit in `selection.ts` —
 *    the framework code never needs to change continuously.
 *  - `status()` reports which backend is active and, per op, which impl is
 *    bound and the measured native:JS ratio.
 *
 * The default `backend` singleton is constructed eagerly at import — this is
 * deliberately a LOAD-TIME cost, not a runtime one (ignus optimizes runtime
 * speed; slower load is acceptable). `createExecutionBackend()` exists for
 * isolated instances (tests, apps that want a frozen snapshot).
 *
 * Note on "pre-bound": each facade method IS the selection-aware wrapper, so
 * the only per-call overhead is a boolean selection check — it keeps the
 * selection table hot-editable without rebuilding the facade.
 */

import {
  aeadDecrypt,
  aeadEncrypt,
  csrfToken,
  csrfVerify,
  hmacSha256,
  hmacSha256Verify,
  type JwtSignOptions,
  type JwtVerifyOptions,
  jwtSign,
  jwtVerify,
  type PasswordHashOptions,
  passwordHash,
  passwordVerify,
  randomToken,
  signCookie,
  verifyCookie,
} from "./crypto";
import { crc32, fnv1a64, fnv1a64String } from "./hash";
import {
  type AcceptNegotiator,
  type ConditionalRequest,
  cookiePairs,
  createAcceptNegotiator,
  createConditionalRequest,
  type EncodingPrefResult,
  etag,
  formPairs,
  type MediaTypeResult,
  type MultipartLimits,
  type MultipartPart,
  mediaTypeMatches,
  multipartParse,
  type Pairs,
  parseAcceptEncoding,
  parseCookie,
  parseForm,
  parseMediaType,
  parseQuery,
  queryPairs,
} from "./http";
import { createSchemaValidator, jsonPatch, jsonValid, type SchemaValidator } from "./json";
import {
  brotliCompress,
  brotliDecompress,
  gzipCompress,
  gzipDecompress,
  sseEncode,
  type WsFrame,
  wsAcceptKey,
  wsFrameDecode,
  wsFrameEncode,
} from "./payload";
import { createNativePipeline } from "./pipeline";
import {
  createRateLimiter,
  type RateCheck,
  type RateLimiter,
  type RateLimiterOptions,
} from "./ratelimit";
import { backendName, native } from "./runtime";
import { type ExecutionBackend, OPS, type OpName, SELECTION } from "./selection";
import { createTemplate, renderTemplate } from "./template";
import { decoder, encoder, fromBytes, toBytes } from "./util";
import { validateEmail, validateIpv4, validateIpv6, validateUuid } from "./validation";

/** Per-op execution status row. */
export interface ExecutionOpStatus {
  readonly op: OpName;
  readonly impl: ExecutionBackend;
  readonly nativeRatio: number | undefined;
}

/** Snapshot of the active execution backend and per-op selection decisions. */
export interface ExecutionStatus {
  /** Overall active backend ("castrum" when the addon is loaded). */
  readonly backend: ExecutionBackend;
  /** Whether the Rust addon is loaded at all. */
  readonly nativeAvailable: boolean;
  /** Per-op decision rows (from the selection table). */
  readonly ops: ReadonlyArray<ExecutionOpStatus>;
}

const hash = { fnv1a64, crc32, fnv1a64String };

const crypto = {
  hmacSha256,
  hmacSha256Verify,
  signCookie,
  verifyCookie,
  csrfToken,
  csrfVerify,
  jwtSign,
  jwtVerify,
  passwordHash,
  passwordVerify,
  aeadEncrypt,
  aeadDecrypt,
  randomToken,
};

const http = {
  queryPairs,
  parseQuery,
  cookiePairs,
  parseCookie,
  formPairs,
  parseForm,
  parseMediaType,
  mediaTypeMatches,
  etag,
  multipartParse,
  parseAcceptEncoding,
  createAcceptNegotiator,
  createConditionalRequest,
};

const json = { jsonValid, jsonPatch, createSchemaValidator };

const payload = {
  gzipCompress,
  gzipDecompress,
  brotliCompress,
  brotliDecompress,
  sseEncode,
  wsFrameEncode,
  wsFrameDecode,
  wsAcceptKey,
};

const template = { createTemplate, renderTemplate };

const validation = { validateEmail, validateIpv4, validateIpv6, validateUuid };

const ratelimit = { createRateLimiter };

const pipeline = { createNativePipeline };

const util = { toBytes, fromBytes, encoder, decoder };

/** The unified execution backend: every method is bound to its best impl. */
export interface IgnusExecution {
  /** Overall active backend at construction time. */
  readonly backend: ExecutionBackend;
  readonly hash: typeof hash;
  readonly crypto: typeof crypto;
  readonly http: typeof http;
  readonly json: typeof json;
  readonly payload: typeof payload;
  readonly template: typeof template;
  readonly validation: typeof validation;
  readonly ratelimit: typeof ratelimit;
  readonly pipeline: typeof pipeline;
  readonly util: typeof util;
  /** Current selection status (re-reads the table — reflects live edits). */
  readonly status: () => ExecutionStatus;
}

const buildStatus = (): ExecutionStatus => ({
  backend: backendName(),
  nativeAvailable: native != null,
  ops: OPS.map((op) => ({
    op,
    impl: SELECTION[op].impl,
    nativeRatio: SELECTION[op].nativeRatio,
  })),
});

/** Build an isolated execution backend over the shared selection table. */
export const createExecutionBackend = (): IgnusExecution => ({
  backend: backendName(),
  hash,
  crypto,
  http,
  json,
  payload,
  template,
  validation,
  ratelimit,
  pipeline,
  util,
  status: buildStatus,
});

/** The default execution backend — constructed once at import (load-time cost). */
export const backend: IgnusExecution = createExecutionBackend();

/** Current execution status of the default backend. */
export const executionStatus = (): ExecutionStatus => backend.status();

/** The implementation the selection table binds an op to. */
export const implFor = (op: OpName): ExecutionBackend => SELECTION[op].impl;

export type {
  AcceptNegotiator,
  ConditionalRequest,
  EncodingPrefResult,
  JwtSignOptions,
  JwtVerifyOptions,
  MediaTypeResult,
  MultipartLimits,
  MultipartPart,
  Pairs,
  PasswordHashOptions,
  RateCheck,
  RateLimiter,
  RateLimiterOptions,
  SchemaValidator,
  WsFrame,
};
