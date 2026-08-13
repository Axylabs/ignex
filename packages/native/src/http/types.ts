/**
 * @fileoverview HTTP parsing types — shared by the `http/` modules.
 */

/** A list of raw `[name, value]` pairs. */
export type Pairs = ReadonlyArray<[string, string]>;

/** A parsed media type with optional charset/boundary and raw params. */
export interface MediaTypeResult {
  /** Lowercased `type/subtype`. */
  mediaType: string;
  charset?: string;
  boundary?: string;
  params: Record<string, string>;
}

/** A single `Accept-Encoding` preference with quality and order. */
export interface EncodingPrefResult {
  encoding: string;
  q: number;
  order: number;
}

/** One parsed multipart part (field or file). */
export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Uint8Array;
}

/** Multipart parsing limits (DoS guards). */
export interface MultipartLimits {
  maxParts?: number;
  maxFieldCount?: number;
  maxPartBytes?: number;
  maxTotalBytes?: number;
}
