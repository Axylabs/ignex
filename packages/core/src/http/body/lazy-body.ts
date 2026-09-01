/**
 * @fileoverview Lazy body parsing for production performance.
 *
 * Body parsing is deferred until actually needed.
 * Uses Bun-native parsers:
 * - req.json()
 * - req.text()
 * - req.formData()
 * - req.arrayBuffer()
 *
 * The orchestrator owns the single-parse state machine; the heavy lifting is
 * split into pure, unit-testable helpers (`conversion.ts`, `size.ts`,
 * `form-data.ts`, `limits.ts`, `errors.ts`).
 */

import { formPairs } from "@ignex/native";
import { convertBody } from "./conversion";
import { BodyParseError } from "./errors";
import {
  forEachFormDataEntry,
  formDataToObject,
  formDataToRecord,
  getAllFormDataEntries,
  getFormDataEntry,
  isFile,
} from "./form-data";
import { resolveLimits } from "./limits";
import { assertContentLength, assertParsedSize, readBodyBounded } from "./size";
import type { BodyKind, LazyBody, LazyBodyOptions } from "./types";

/** UTF-8 decoder for bounded raw-byte reads (shared, stateless for our use). */
const utf8 = new TextDecoder();

/**
 * Normalized media type of a request's `Content-Type` header — lowercased,
 * with parameters (e.g. `; charset=utf-8`) stripped. Empty string when the
 * header is absent.
 */
const contentType = (req: Request): string =>
  (req.headers.get("content-type") || "").split(";")[0]?.trim().toLowerCase() ?? "";

/**
 * Create a lazily-parsed view over a request body.
 *
 * Parsing is deferred until a parse method is first called and the result is
 * cached, so at most one underlying `req.*()` read ever happens. Calling the
 * returned function as a body selects a kind from `Content-Type`. Size limits
 * are enforced by a `content-length` pre-check plus a post-parse byte guard
 * (the latter also covers chunked bodies with no content-length header).
 *
 * @param req - The incoming request.
 * @param opts - Optional per-kind size limits (defaults in `limits.ts`).
 * @returns A `LazyBody` with typed parse accessors and cross-kind conversion.
 */
export function createLazyBody(req: Request, opts: LazyBodyOptions = {}): LazyBody {
  const limits = resolveLimits(opts);

  let kind: BodyKind = "none";
  let value: unknown;

  // Raw wire-byte length of the parsed body, captured at parse time so the
  // post-parse size guard never has to re-serialize (JSON.stringify) the
  // parsed value to measure it — the wire bytes are the correct size to guard
  // (consistent with the content-length pre-check) and measuring them is free.
  let parsedRawBytes = 0;

  let pending: Promise<unknown> | null = null;
  let pendingKind: BodyKind | null = null;

  async function use<T>(target: BodyKind, parser: () => Promise<T>, max?: number): Promise<T> {
    if (kind === target) return value as T;
    if (kind !== "none") return convertBody({ kind, value }, target) as T;

    if (pending) {
      if (pendingKind === target) return pending as Promise<T>;

      throw new BodyParseError(`Body parse already in progress as "${pendingKind}".`, 409);
    }

    assertContentLength(req, max);

    pendingKind = target;

    pending = parser()
      .then((v) => {
        assertParsedSize(target, v, max, parsedRawBytes);
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

    const ct = contentType(req);

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
          // Fast path: when content-length is present the raw wire-byte length
          // is already known, so parse straight from bytes via Bun's native
          // req.json() — skipping the text → TextEncoder → JSON.parse
          // round-trip — and reuse the header value for the post-parse size
          // guard (`parsedRawBytes`/`assertParsedSize`).
          const contentLength = req.headers.get("content-length");
          const len =
            contentLength === null || contentLength.trim() === ""
              ? Number.NaN
              : Number(contentLength);
          if (Number.isFinite(len) && len >= 0) {
            parsedRawBytes = len;
            return (await req.json()) as T;
          }
          // Chunked body (no content-length): Bun's req.json()/req.text()
          // would buffer the WHOLE stream (up to Bun.serve's
          // maxRequestBodySize per in-flight request) BEFORE any size guard
          // could run — a transient memory amplification under concurrent
          // attack. Read through `readBodyBounded`, which aborts mid-stream
          // with 413 the moment the running total exceeds the limit.
          const bytes = await readBodyBounded(req, limits.maxJsonBytes);
          parsedRawBytes = bytes.byteLength;
          return JSON.parse(utf8.decode(bytes)) as T;
        } catch (err) {
          if (err instanceof BodyParseError) throw err;
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
          // Chunked bodies stream under the cap (see json() above); bodies
          // with content-length keep Bun's native fast path.
          const contentLength = req.headers.get("content-length");
          if (contentLength !== null && contentLength.trim() !== "") {
            return await req.text();
          }
          return utf8.decode(await readBodyBounded(req, limits.maxTextBytes));
        } catch (err) {
          if (err instanceof BodyParseError) throw err;
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
          const contentLength = req.headers.get("content-length");
          if (contentLength !== null && contentLength.trim() !== "") {
            return await req.arrayBuffer();
          }
          const bytes = await readBodyBounded(req, limits.maxFileBytes);
          const out = new ArrayBuffer(bytes.byteLength);
          new Uint8Array(out).set(bytes);
          return out;
        } catch (err) {
          if (err instanceof BodyParseError) throw err;
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
          const contentLength = req.headers.get("content-length");
          if (contentLength !== null && contentLength.trim() !== "") {
            return await req.blob();
          }
          const bytes = await readBodyBounded(req, limits.maxFileBytes);
          const copy = new Uint8Array(bytes.byteLength);
          copy.set(bytes);
          return new Blob([copy.buffer as ArrayBuffer]);
        } catch (err) {
          if (err instanceof BodyParseError) throw err;
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
          // application/x-www-form-urlencoded: `formPairs` is the single source
          // of truth for form parsing — the selection table (src/selection.ts)
          // owns the impl choice (JS wins for scalar form parsing), so behavior
          // is identical with or without the addon and duplicates/order are
          // preserved exactly like Bun's native FormData.
          const ct = contentType(req);

          if (ct === "application/x-www-form-urlencoded") {
            const contentLength = req.headers.get("content-length");
            const text =
              contentLength !== null && contentLength.trim() !== ""
                ? await req.text()
                : // Chunked: bounded read (see json() above).
                  utf8.decode(await readBodyBounded(req, limits.maxFormBytes));
            const fd = new FormData();
            for (const [name, value] of formPairs(text)) fd.append(name, value);
            return fd as unknown as FormData;
          }

          // Multipart goes through Bun's parser (which owns its own limits);
          // the content-length pre-check + post-parse guard still apply.
          return (await req.formData()) as unknown as FormData;
        } catch (err) {
          if (err instanceof BodyParseError) throw err;
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
