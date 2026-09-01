/**
 * @fileoverview File response helpers:
 * - static file serving
 * - downloads
 * - HTTP range requests
 * - conditional requests
 * - mtime/ETag browser caching
 */

import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, normalize, resolve, sep } from "node:path";
import { cacheControl } from "../data/cache";
import { ForbiddenError, NotFoundError } from "../platform/errors";
import { isNotModified } from "./conditional";

/** Options for {@link sendFile}. */
export interface SendFileOptions {
  req?: Request;
  download?: boolean | string;
  contentType?: string;
  maxAge?: number;
  swr?: number;
  immutable?: boolean;
  isPrivate?: boolean;
}

/** Options for {@link streamDownload}. */
export interface StreamDownloadOptions {
  filename?: string;
  contentType?: string;
  cacheControl?: string;
  size?: number;
}

/**
 * Prevent path traversal.
 *
 * Example:
 *   safeJoin("public", ctx.params.path)
 *
 * Symlink-hardened: both the root and the joined target are resolved to their
 * real paths (when they exist), so a symlink inside the root pointing OUTSIDE
 * it is rejected — the old purely-lexical check happily served such files.
 * Non-existent targets keep the lexical resolution (the caller's stat/404
 * handles them).
 */
export function safeJoin(root: string, target: string): string {
  let resolvedRoot = resolve(root);
  try {
    resolvedRoot = realpathSync(resolvedRoot);
  } catch {
    /* missing root — lexical path stands; the caller's stat() reports ENOENT */
  }

  const lexical = resolve(resolvedRoot, normalize(target));

  let resolved = lexical;
  try {
    resolved = realpathSync(lexical);
  } catch {
    /* target does not exist yet — nothing to re-resolve */
  }

  if (!resolved.startsWith(resolvedRoot + sep)) {
    throw new ForbiddenError("Invalid file path");
  }

  return resolved;
}

const rangeNotSatisfiable = (size: number): Response =>
  new Response("Range Not Satisfiable", {
    status: 416,
    headers: { "content-range": `bytes */${size}` },
  });

/**
 * Serve an HTTP `Range` request against a file (206 partial or 416).
 *
 * The bounded slice is materialized because Bun 1.4's `response.body` getter
 * re-streams the FULL file when a sliced BunFile-backed Response is re-wrapped
 * (e.g. plugins/applySet add headers or cookies), which would corrupt the 206
 * body. A materialized range is small and survives re-wrapping.
 */
async function serveRange(
  file: Blob,
  size: number,
  headers: Headers,
  range: string,
): Promise<Response> {
  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) return rangeNotSatisfiable(size);

  let start: number;
  let end: number;
  if (match[1] === "" && match[2] !== "") {
    // Suffix range: bytes=-500
    const suffix = parseInt(match[2] as string, 10);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = match[1] ? parseInt(match[1], 10) : 0;
    end = match[2] ? parseInt(match[2], 10) : size - 1;
  }

  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
    return rangeNotSatisfiable(size);
  }

  end = Math.min(end, size - 1);
  headers.set("content-range", `bytes ${start}-${end}/${size}`);
  headers.set("content-length", String(end - start + 1));

  const sliced = await file.slice(start, end + 1).arrayBuffer();
  return new Response(sliced, { status: 206, headers });
}

/**
 * Serve a static file with ETag/Last-Modified caching and HTTP range support.
 *
 * Requires the Bun runtime (`Bun.file`). Pass a request that came through
 * `safeJoin` (or validate the path yourself) so `path` cannot escape its
 * intended directory — this helper does not sandbox the path.
 *
 * @param path - Absolute path to the file (validated by the caller).
 * @param opts - Request (for conditional/range), download, caching controls.
 * @throws NotFoundError when the path is not a file; ForbiddenError from
 * `safeJoin` when the caller used it and traversal was attempted.
 */
export async function sendFile(path: string, opts: SendFileOptions = {}): Promise<Response> {
  const stats = await stat(path).catch(() => null);

  if (!stats?.isFile()) {
    throw new NotFoundError("File");
  }

  const bun = (globalThis as { Bun?: { file: (p: string) => Blob } }).Bun;
  if (!bun?.file) {
    throw new Error("sendFile requires the Bun runtime");
  }
  const file = bun.file(path);

  const etag = `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;

  const lastModified = stats.mtime.toUTCString();

  const headers = new Headers();

  headers.set("content-type", opts.contentType || file.type || "application/octet-stream");

  headers.set(
    "cache-control",
    cacheControl({
      public: !opts.isPrivate,
      maxAge: opts.maxAge ?? 3600,
      ...(opts.isPrivate !== undefined ? { private: opts.isPrivate } : {}),
      ...(opts.swr !== undefined ? { swr: opts.swr } : {}),
      ...(opts.immutable !== undefined ? { immutable: opts.immutable } : {}),
    }),
  );

  headers.set("etag", etag);
  headers.set("last-modified", lastModified);
  headers.set("accept-ranges", "bytes");
  // Content-type comes from the file extension (Bun) or the caller — never
  // trust it as ground truth for execution decisions in the browser. `nosniff`
  // stops MIME-sniffing from upgrading a text/unknown upload into script.
  headers.set("x-content-type-options", "nosniff");

  if (opts.download) {
    const filename = typeof opts.download === "string" ? opts.download : basename(path);

    headers.set("content-disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
  }

  if (opts.req && isNotModified(opts.req, etag, lastModified)) {
    return new Response(null, {
      status: 304,
      headers,
    });
  }

  const range = opts.req?.headers.get("range");

  if (range) {
    return serveRange(file, stats.size, headers, range);
  }

  headers.set("content-length", String(stats.size));

  return new Response(file, {
    status: 200,
    headers,
  });
}

/**
 * Stream a `ReadableStream` as a download (or arbitrary) response.
 *
 * Sets `Content-Disposition: attachment` when `filename` is provided and
 * `Content-Length` when `size` is known.
 */
export function streamDownload(stream: ReadableStream, opts: StreamDownloadOptions = {}): Response {
  const headers = new Headers({
    "content-type": opts.contentType || "application/octet-stream",
    "cache-control": opts.cacheControl || "no-store",
    // Same rationale as sendFile: never let the browser sniff around the
    // declared content type.
    "x-content-type-options": "nosniff",
  });

  if (opts.filename) {
    headers.set("content-disposition", `attachment; filename="${opts.filename.replace(/"/g, "")}"`);
  }

  if (opts.size != null) {
    headers.set("content-length", String(opts.size));
  }

  return new Response(stream, {
    status: 200,
    headers,
  });
}
