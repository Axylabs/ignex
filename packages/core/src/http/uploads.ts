/**
 * @fileoverview Authenticated file uploads for compiled (AOT) apps — parse,
 * validate, store, and serve, with the security posture production apps need:
 *
 * - server-generated unguessable names (`<uuid>.<ext>`) — user input never
 *   touches a filesystem path;
 * - strict content-type allowlist (SVG is deliberately absent: it is an
 *   active-XSS payload when served inline);
 * - hard size cap (default 10 MB);
 * - serving validates the generated-name shape, making path traversal
 *   impossible; immutable caches (names are unique forever).
 *
 * Route files stay thin (the compiler discovers file routes):
 *
 * ```ts
 * // src/routes/upload.post.ts
 * export default post(async (ctx) => {
 *   const user = await requireCurrentUser(ctx);
 *   const result = await saveUpload(ctx, { dir: uploadDir(), maxBytes: 10 << 20, allowed: UPLOAD_TYPES });
 *   if (!result.ok) return ctx.json({ error: result.error }, { status: result.status });
 *   return ctx.json({ ...result.file, uploadedBy: user._id.toString() }, { status: 201 });
 * });
 * ```
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IgnexContext } from "../http/context";
import { sendFile } from "../http/files";
import { NotFoundError } from "../platform/errors";

/** Content types accepted by an upload endpoint, mapped to file extensions. */
export type UploadTypes = Readonly<Record<string, string>>;

/** Common image + PDF types (no SVG — active-XSS when served inline). */
export const DEFAULT_UPLOAD_TYPES: UploadTypes = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
};

/** Options for {@link saveUpload}. */
export interface SaveUploadOptions {
  /** Storage directory (created on demand). Flat files only. */
  dir: string;
  /** Hard size cap in bytes. */
  maxBytes?: number;
  /** Accepted content types → extensions (default {@link DEFAULT_UPLOAD_TYPES}). */
  allowed?: UploadTypes;
  /** The form field holding the File (default `"file"`). */
  field?: string;
}

/** A persisted upload (server-generated name inside `dir`). */
export interface SavedUpload {
  name: string;
  url: string;
  /** The client-supplied filename, sanitized for storage/display only. */
  uploaded: string;
  size: number;
  contentType: string;
}

/** A rejected upload: map `status` onto your error response shape. */
export interface UploadRejection {
  ok: false;
  status: 400 | 413 | 415;
  error: string;
}

/** A successful save. */
export interface UploadSuccess {
  ok: true;
  file: SavedUpload;
}

/** Strip control characters (path-safe, display-safe). */
const stripControlChars = (value: string): string =>
  [...value]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("");

/**
 * Sanitize a client-supplied filename: strip path separators + control
 * chars, cap the length. Informational only — never used as a path.
 */
export const sanitizeFileName = (name: string): string => {
  const base = stripControlChars(name)
    .replace(/[/\\<>:"|?*]/g, "_")
    .trim();
  return base.slice(0, 160) || "upload";
};

const megabytes = (mb: number): number => mb * 1024 * 1024;

/**
 * Parse a multipart upload from `ctx`, validate it against the options, and
 * persist it under `dir` with an unguessable server-generated name. Never
 * throws for rejectable inputs — returns a `{ ok: false, status, error }`
 * result so route files keep their own response shapes.
 */
export const saveUpload = async (
  ctx: Pick<IgnexContext, "body">,
  options: SaveUploadOptions,
): Promise<UploadSuccess | UploadRejection> => {
  const maxBytes = options.maxBytes ?? megabytes(10);
  const allowed = options.allowed ?? DEFAULT_UPLOAD_TYPES;
  const field = options.field ?? "file";

  const form = await ctx.body.formData();
  const file = form.get(field);

  if (!(file instanceof File)) {
    return { ok: false, status: 400, error: "Missing file field" };
  }
  if (file.size === 0) {
    return { ok: false, status: 400, error: "Empty file" };
  }
  if (file.size > maxBytes) {
    return {
      ok: false,
      status: 413,
      error: `File exceeds ${Math.floor(maxBytes / (1024 * 1024))} MB limit`,
    };
  }
  const contentType = file.type || "application/octet-stream";
  const ext = allowed[contentType];
  if (!ext) {
    return { ok: false, status: 415, error: `Unsupported content type "${contentType}"` };
  }

  mkdirSync(options.dir, { recursive: true });
  const name = `${randomUUID()}.${ext}`;
  await writeFile(join(options.dir, name), Buffer.from(await file.arrayBuffer()));

  return {
    ok: true,
    file: {
      name,
      url: `/uploads/${name}`,
      uploaded: sanitizeFileName(file.name),
      size: file.size,
      contentType,
    },
  };
};

/** Options for {@link serveUpload}. */
export interface ServeUploadOptions {
  /** Storage directory (same value passed to {@link saveUpload}). */
  dir: string;
  /** Accepted extensions (derived from `allowed` when omitted). */
  extensions?: readonly string[];
  /** Browser cache seconds (default one year — names are unique forever). */
  maxAge?: number;
  /** The incoming request (enables conditional revalidation). */
  req?: Request;
}

/**
 * Serve a persisted upload by its server-generated name. The strict
 * `<uuid>.<ext>` pattern check makes path traversal impossible and only ever
 * resolves to a flat file inside `dir`. Throws NotFoundError for bad names /
 * missing files (framework error mapping applies).
 */
export const serveUpload = async (name: string, options: ServeUploadOptions): Promise<Response> => {
  const exts = options.extensions ?? Object.values(DEFAULT_UPLOAD_TYPES);
  const pattern = new RegExp(
    `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(${exts.join("|")})$`,
  );
  if (!pattern.test(name)) throw new NotFoundError();
  const filePath = join(options.dir, name);
  if (!existsSync(filePath)) throw new NotFoundError();
  return sendFile(filePath, {
    ...(options.req !== undefined ? { req: options.req } : {}),
    maxAge: options.maxAge ?? 315_36000,
    swr: options.maxAge ?? 315_36000,
  });
};
