/**
 * @fileoverview Lazy body parsing for production performance.
 *
 * Body parsing is deferred until actually needed.
 * Uses Bun-native parsers:
 * - req.json()
 * - req.text()
 * - req.formData()
 * - req.arrayBuffer()
 */

import { formPairs, isNativeAvailable } from "@flux/native";
import { HTTPError } from "../platform/errors";

/**
 * Raised when a request body cannot be parsed (malformed JSON, oversize,
 * unsupported content type). Extends {@link HTTPError} so it flows through
 * `errorToResponse` with its `status` intact instead of leaking as a 500.
 */
export class BodyParseError extends HTTPError {
  constructor(message: string, status = 400) {
    super(status, message, "BODY_PARSE_ERROR");
    this.name = "BodyParseError";
  }
}

export interface LazyBodyOptions {
  maxJsonBytes?: number;
  maxTextBytes?: number;
  maxFormBytes?: number;
  maxFileBytes?: number;
}

type BodyKind = "none" | "json" | "text" | "formData" | "arrayBuffer" | "blob";

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

const DEFAULT_LIMITS = {
  maxJsonBytes: 2 * 1024 * 1024,
  maxTextBytes: 2 * 1024 * 1024,
  maxFormBytes: 2 * 1024 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
};

const forEachFormDataEntry = (fd: FormData, cb: (value: unknown, key: string) => void): void => {
  const forEach = (fd as unknown as { forEach?: unknown }).forEach;

  if (typeof forEach === "function") {
    (forEach as (cb: (value: unknown, key: string) => void) => void).call(fd, cb);
  }
};

const getFormDataEntry = (fd: FormData, name: string): unknown => {
  const get = (fd as unknown as { get?: unknown }).get;

  if (typeof get !== "function") {
    return null;
  }

  return (get as (name: string) => unknown).call(fd, name);
};

const getAllFormDataEntries = (fd: FormData, name: string): unknown[] => {
  const getAll = (fd as unknown as { getAll?: unknown }).getAll;

  if (typeof getAll !== "function") {
    return [];
  }

  const values = (getAll as (name: string) => unknown).call(fd, name);

  return Array.isArray(values) ? values : [];
};

const isFile = (value: unknown): value is File =>
  typeof File !== "undefined" && value instanceof File;

function formDataToRecord(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};

  forEachFormDataEntry(fd, (value, key) => {
    if (typeof value === "string") {
      out[key] = value;
    } else if (isFile(value)) {
      out[key] = value.name;
    }
  });

  return out;
}

function formDataToObject(fd: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  forEachFormDataEntry(fd, (value, key) => {
    const existing = out[key];

    if (existing === undefined) {
      out[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      out[key] = [existing, value];
    }
  });

  return out;
}

export function createLazyBody(req: Request, opts: LazyBodyOptions = {}): LazyBody {
  const limits = {
    maxJsonBytes: opts.maxJsonBytes ?? DEFAULT_LIMITS.maxJsonBytes,
    maxTextBytes: opts.maxTextBytes ?? DEFAULT_LIMITS.maxTextBytes,
    maxFormBytes: opts.maxFormBytes ?? DEFAULT_LIMITS.maxFormBytes,
    maxFileBytes: opts.maxFileBytes ?? DEFAULT_LIMITS.maxFileBytes,
  };

  let kind: BodyKind = "none";
  let value: unknown;

  let pending: Promise<unknown> | null = null;
  let pendingKind: BodyKind | null = null;

  function assertSize(max?: number): void {
    if (!max) return;

    const len = Number(req.headers.get("content-length") || "0");
    if (Number.isFinite(len) && len > max) {
      throw new BodyParseError("Payload too large", 413);
    }
  }

  const textByteLength = (text: string): number => new TextEncoder().encode(text ?? "").byteLength;

  /**
   * Enforce size limits on the parsed value. The `content-length` pre-check in
   * `assertSize` is bypassed by chunked transfer encoding (no content-length
   * header), so an unbounded `req.text()/json()/formData()` would otherwise
   * buffer arbitrarily large payloads. This post-parse guard closes that hole.
   */
  function assertParsedSize(target: BodyKind, parsed: unknown, max?: number): void {
    if (!max) return;

    let size = 0;

    switch (target) {
      case "text":
        size = textByteLength(parsed as string);
        break;
      case "json":
        size = textByteLength(JSON.stringify(parsed) ?? "");
        break;
      case "arrayBuffer":
        size = (parsed as ArrayBuffer).byteLength;
        break;
      case "blob":
        size = (parsed as Blob).size;
        break;
      case "formData": {
        forEachFormDataEntry(parsed as FormData, (value) => {
          if (typeof value === "string") size += textByteLength(value);
          else if (isFile(value)) size += value.size;
        });
        break;
      }
      default:
        return;
    }

    if (size > max) {
      throw new BodyParseError("Payload too large", 413);
    }
  }

  function convert<T>(target: BodyKind): T {
    if (kind === target) return value as T;

    if (kind === "json") {
      const text = JSON.stringify(value);

      if (target === "text") return text as T;
      if (target === "arrayBuffer") {
        return new TextEncoder().encode(text).buffer as T;
      }
      if (target === "blob") {
        return new Blob([text], { type: "application/json" }) as T;
      }
    }

    if (kind === "text") {
      const text = value as string;

      if (target === "json") return JSON.parse(text) as T;
      if (target === "arrayBuffer") {
        return new TextEncoder().encode(text).buffer as T;
      }
      if (target === "blob") return new Blob([text]) as T;

      if (target === "formData") {
        const fd = new FormData();
        new URLSearchParams(text).forEach((v, k) => fd.append(k, v));
        return fd as T;
      }
    }

    if (kind === "arrayBuffer") {
      const buf = value as ArrayBuffer;
      const text = new TextDecoder().decode(buf);

      if (target === "text") return text as T;
      if (target === "json") return JSON.parse(text) as T;
      if (target === "blob") return new Blob([buf]) as T;
    }

    if (kind === "formData") {
      const fd = value as FormData;

      if (target === "text") {
        const params = new URLSearchParams();

        forEachFormDataEntry(fd, (v, k) => {
          if (typeof v === "string") {
            params.append(k, v);
          }
        });

        return params.toString() as T;
      }
    }

    throw new BodyParseError(
      `Body already consumed as "${kind}"; cannot parse as "${target}".`,
      409,
    );
  }

  async function use<T>(target: BodyKind, parser: () => Promise<T>, max?: number): Promise<T> {
    if (kind === target) return value as T;
    if (kind !== "none") return convert<T>(target);

    if (pending) {
      if (pendingKind === target) return pending as Promise<T>;

      throw new BodyParseError(`Body parse already in progress as "${pendingKind}".`, 409);
    }

    assertSize(max);

    pendingKind = target;

    pending = parser()
      .then((v) => {
        assertParsedSize(target, v, max);
        kind = target;
        value = v;
        pending = null;
        pendingKind = null;
        return v;
      })
      .catch((err) => {
        pending = null;
        pendingKind = null;
        throw err;
      });

    return pending as Promise<T>;
  }

  function assertFileSize(file: File): void {
    if (limits.maxFileBytes && file.size > limits.maxFileBytes) {
      throw new BodyParseError("File too large", 413);
    }
  }

  const fn = async (): Promise<unknown> => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      return undefined;
    }

    const ct = (req.headers.get("content-type") || "").split(";")[0]?.trim().toLowerCase();

    if (!ct) return undefined;

    const self = fn as unknown as LazyBody;

    if (ct.includes("json")) return self.json();
    if (ct.includes("x-www-form-urlencoded")) return self.form();
    if (ct.includes("multipart/form-data")) return self.multipart();
    if (ct.startsWith("text/")) return self.text();

    return self.arrayBuffer();
  };

  const body = fn as unknown as LazyBody;

  body.json = <T = unknown>() =>
    use<T>(
      "json",
      async () => {
        try {
          // Read raw text first so the parsed size can be measured against
          // maxJsonBytes regardless of whether content-length was present.
          const text = await req.text();
          return JSON.parse(text) as T;
        } catch {
          throw new BodyParseError("Invalid JSON body", 400);
        }
      },
      limits.maxJsonBytes,
    );

  body.text = () =>
    use<string>(
      "text",
      async () => {
        try {
          return await req.text();
        } catch {
          throw new BodyParseError("Invalid text body", 400);
        }
      },
      limits.maxTextBytes,
    );

  body.arrayBuffer = () =>
    use<ArrayBuffer>(
      "arrayBuffer",
      async () => {
        try {
          return await req.arrayBuffer();
        } catch {
          throw new BodyParseError("Invalid binary body", 400);
        }
      },
      limits.maxFileBytes,
    );

  body.blob = () =>
    use<Blob>(
      "blob",
      async () => {
        try {
          return await req.blob();
        } catch {
          throw new BodyParseError("Invalid blob body", 400);
        }
      },
      limits.maxFileBytes,
    );

  body.formData = () =>
    use<FormData>(
      "formData",
      async () => {
        try {
          // application/x-www-form-urlencoded: use the Rust addon's packed
          // form parser when present (byte-identical output — duplicates and
          // order preserved so later conversions behave exactly like Bun's
          // native FormData). Falls back to Bun when native is unavailable.
          const ct = (req.headers.get("content-type") || "").split(";")[0]?.trim().toLowerCase();

          if (ct === "application/x-www-form-urlencoded" && isNativeAvailable()) {
            const text = await req.text();
            const fd = new FormData();
            for (const [name, value] of formPairs(text)) fd.append(name, value);
            return fd as unknown as FormData;
          }

          return (await req.formData()) as unknown as FormData;
        } catch {
          throw new BodyParseError("Invalid form/multipart body", 400);
        }
      },
      limits.maxFormBytes,
    );

  body.form = async () => {
    const fd = await body.formData();
    return formDataToRecord(fd);
  };

  body.multipart = async () => {
    const fd = await body.formData();
    return formDataToObject(fd);
  };

  body.file = async (name?: string) => {
    const fd = await body.formData();

    if (name) {
      const value = getFormDataEntry(fd, name);

      if (isFile(value)) {
        assertFileSize(value);
        return value;
      }

      return null;
    }

    let found: File | null = null;

    forEachFormDataEntry(fd, (value) => {
      if (!found && isFile(value)) {
        assertFileSize(value);
        found = value;
      }
    });

    return found;
  };

  body.files = async (name?: string) => {
    const fd = await body.formData();
    const files: File[] = [];

    if (name) {
      for (const value of getAllFormDataEntries(fd, name)) {
        if (isFile(value)) {
          assertFileSize(value);
          files.push(value);
        }
      }

      return files;
    }

    forEachFormDataEntry(fd, (value) => {
      if (isFile(value)) {
        assertFileSize(value);
        files.push(value);
      }
    });

    return files;
  };

  body.stream = () => {
    if (kind !== "none") return null;
    return req.body;
  };

  Object.defineProperty(body, "consumed", {
    get: () => kind !== "none",
  });

  Object.defineProperty(body, "parsed", {
    get: () => value,
  });

  return body;
}
