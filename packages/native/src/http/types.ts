/**
 * @fileoverview HTTP parsing types — shared by the `http/` modules.
 */

export type Pairs = ReadonlyArray<[string, string]>;

export interface MediaTypeResult {
  /** Lowercased `type/subtype`. */
  mediaType: string;
  charset?: string;
  boundary?: string;
  params: Record<string, string>;
}

export interface EncodingPrefResult {
  encoding: string;
  q: number;
  order: number;
}

export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Uint8Array;
}

export interface MultipartLimits {
  maxParts?: number;
  maxFieldCount?: number;
  maxPartBytes?: number;
  maxTotalBytes?: number;
}
