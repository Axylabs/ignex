/**
 * Ambient type surface for the `castrum` NAPI addon.
 *
 * This is the SUB-SET of castrum's generated `index.d.ts` that flux uses.
 * It is mapped through the root tsconfig `paths` (`"castrum": [...]`), so
 * TypeScript resolves the module even when the addon isn't installed; at
 * runtime the loader resolves the real package (native) or falls back to
 * the pure-TS implementations. Keeping a trimmed, hand-maintained surface
 * here avoids shipping the full generated `index.d.ts` and makes the exact
 * native contract we rely on explicit.
 *
 * Note: byte parameters/returns are declared as `Uint8Array` even though
 * the real addon returns Node `Buffer`s (a `Buffer` IS a `Uint8Array`), so
 * the wrappers never need casts.
 */

export declare class TemplateRenderer {
  constructor(source: string);
  render(context: any): Uint8Array;
}

export interface EncodingPrefResult {
  encoding: string;
  q: number;
  order: number;
}

export interface MediaTypeResult {
  mediaType: string;
  charset?: string;
  boundary?: string;
  params: Record<string, string>;
}

export interface MultipartLimitsInput {
  maxParts?: number;
  maxFieldCount?: number;
  maxPartBytes?: number;
  maxTotalBytes?: number;
}

export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Uint8Array;
}

export interface PasswordHashOptions {
  mCost?: number;
  tCost?: number;
  pCost?: number;
  outLen?: number;
}

export interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Uint8Array;
}

export declare function fnv1a64(input: Uint8Array): bigint;
export declare function crc32(input: Uint8Array): number;
export declare function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array;
export declare function hmacSha256Verify(
  key: Uint8Array,
  data: Uint8Array,
  sig: Uint8Array,
): boolean;
export declare function signCookie(value: Uint8Array, secret: Uint8Array): Uint8Array;
export declare function verifyCookie(signed: Uint8Array, secret: Uint8Array): Uint8Array | null;
export declare function csrfToken(secret: Uint8Array): Uint8Array;
export declare function csrfVerify(token: Uint8Array, secret: Uint8Array): boolean;
export declare function jwtSign(
  claims: any,
  secret: Uint8Array,
  ttlSeconds: number | null,
  nowSeconds: number,
): Uint8Array;
export declare function jwtVerify(token: Uint8Array, secret: Uint8Array, nowSeconds: number): any;
export declare function randomToken(byteLen: number): Uint8Array;
export declare function passwordHash(
  password: Uint8Array,
  salt: Uint8Array,
  options?: PasswordHashOptions | null,
): Uint8Array;
export declare function passwordVerify(password: Uint8Array, phc: Uint8Array): boolean;
export declare function aeadEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  algorithm?: string | null,
): Uint8Array;
export declare function aeadDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  algorithm?: string | null,
): Uint8Array | null;
export declare function queryParsePacked(input: Uint8Array): Uint8Array;
export declare function cookieParsePacked(input: Uint8Array): Uint8Array;
export declare function parseMediaType(input: Uint8Array): MediaTypeResult;
export declare function etag(input: Uint8Array, weak?: boolean | null): Uint8Array;
export declare function multipartParse(
  body: Uint8Array,
  boundary: Uint8Array,
  limits?: MultipartLimitsInput | null,
): Array<MultipartPart>;
export declare function parseAcceptEncoding(input: Uint8Array): Array<EncodingPrefResult>;
export declare function jsonValid(input: Uint8Array): boolean;
export declare function jsonPatch(doc: Uint8Array, patch: Uint8Array): Uint8Array;
export declare function gzipCompress(data: Uint8Array, level?: number | null): Uint8Array;
export declare function gzipDecompress(data: Uint8Array): Uint8Array;
export declare function brotliCompress(data: Uint8Array, quality?: number | null): Uint8Array;
export declare function brotliDecompress(data: Uint8Array): Uint8Array;
export declare function sseEncodeEvent(
  event: string | null,
  data: Uint8Array,
  id?: string | null,
  retry?: number | null,
): Uint8Array;
export declare function wsFrameEncode(
  opcode: number,
  payload: Uint8Array,
  mask: boolean,
  fin: boolean,
): Uint8Array;
export declare function wsFrameDecode(data: Uint8Array): WsFrame | null;
export declare function wsAcceptKey(key: Uint8Array): Uint8Array;
export declare function validateEmail(input: Uint8Array): boolean;
export declare function validateUuid(input: Uint8Array): boolean;
export declare function validateIpv4(input: Uint8Array): boolean;
export declare function validateIpv6(input: Uint8Array): boolean;
