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

import { formPairs } from "@ignus/native";
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
import { assertContentLength, assertParsedSize } from "./size";
import type { BodyKind, LazyBody, LazyBodyOptions } from "./types";

/**
 * Normalized media type of a request's `Content-Type` header — lowercased,
 * with parameters (e.g. `; charset=utf-8`) stripped. Empty string when the
 * header is absent.
 */
const contentType = (req: Request): string =>
  (req.headers.get("content-type") || "").split(";")[0]?.trim().toLowerCase() ?? "";

export function createLazyBody(req: Request, opts: LazyBodyOptions = {}): LazyBody {
  const limits = resolveLimits(opts);

  let kind: BodyKind = "none";
  let value: unknown;

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
          // application/x-www-form-urlencoded: `formPairs` is the single source
          // of truth for form parsing — the selection table (src/selection.ts)
          // owns the impl choice (JS wins for scalar form parsing), so behavior
          // is identical with or without the addon and duplicates/order are
          // preserved exactly like Bun's native FormData.
          const ct = contentType(req);

          if (ct === "application/x-www-form-urlencoded") {
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
