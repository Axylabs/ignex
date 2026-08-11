/**
 * @fileoverview Body parsing types — options, kinds, and the `LazyBody` surface.
 */

export interface LazyBodyOptions {
  maxJsonBytes?: number;
  maxTextBytes?: number;
  maxFormBytes?: number;
  maxFileBytes?: number;
}

export type BodyKind = "none" | "json" | "text" | "formData" | "arrayBuffer" | "blob";

export interface LazyBody {
  (): Promise<unknown>;

  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
  form(): Promise<Record<string, string>>;
  multipart(): Promise<Record<string, unknown>>;
  formData(): Promise<FormData>;

  file(name?: string): Promise<File | null>;
  files(name?: string): Promise<File[]>;

  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;

  /**
   * Returns the raw request stream if the body has not been consumed.
   * Useful for proxying or streaming uploads downstream.
   */
  stream(): ReadableStream<Uint8Array> | null;

  readonly consumed: boolean;
  readonly parsed: unknown;
}

/** The parsed-state carrier threaded through the pure conversion helpers. */
export interface BodyState {
  kind: BodyKind;
  value: unknown;
}
