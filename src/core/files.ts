/**
 * @fileoverview File response helpers:
 * - static file serving
 * - downloads
 * - HTTP range requests
 * - conditional requests
 * - mtime/ETag browser caching
 */

import { stat } from "fs/promises";
import { basename, resolve, normalize, sep } from "path";
import { NotFoundError, ForbiddenError } from "./errors";
import { cacheControl } from "./cache";

export interface SendFileOptions {
  req?: Request;
  download?: boolean | string;
  contentType?: string;
  maxAge?: number;
  swr?: number;
  immutable?: boolean;
  isPrivate?: boolean;
}

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
 */
export function safeJoin(root: string, target: string): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, normalize(target));

  if (!resolved.startsWith(resolvedRoot + sep)) {
    throw new ForbiddenError("Invalid file path");
  }

  return resolved;
}

function isNotModified(
  req: Request,
  etag: string,
  lastModified: string
): boolean {
  const inm = req.headers.get("if-none-match");

  if (
    inm &&
    inm
      .split(",")
      .map((s) => s.trim())
      .includes(etag)
  ) {
    return true;
  }

  const ims = req.headers.get("if-modified-since");

  if (ims && new Date(ims).getTime() >= new Date(lastModified).getTime()) {
    return true;
  }

  return false;
}

export async function sendFile(
  path: string,
  opts: SendFileOptions = {}
): Promise<Response> {
  const stats = await stat(path).catch(() => null);

  if (!stats || !stats.isFile()) {
    throw new NotFoundError("File");
  }

  const file = Bun.file(path);

  const etag = `W/"${stats.size.toString(16)}-${Math.floor(
    stats.mtimeMs
  ).toString(16)}"`;

  const lastModified = stats.mtime.toUTCString();

  const headers = new Headers();

  headers.set(
    "content-type",
    opts.contentType || file.type || "application/octet-stream"
  );

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

  if (opts.download) {
    const filename =
      typeof opts.download === "string"
        ? opts.download
        : basename(path);

    headers.set(
      "content-disposition",
      `attachment; filename="${filename.replace(/"/g, "")}"`
    );
  }

  if (opts.req && isNotModified(opts.req, etag, lastModified)) {
    return new Response(null, {
      status: 304,
      headers,
    });
  }

  const range = opts.req?.headers.get("range");

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);

    if (!match) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: {
          "content-range": `bytes */${stats.size}`,
        },
      });
    }

    let start: number;
    let end: number;

    if (match[1] === "" && match[2] !== "") {
      // Suffix range: bytes=-500
      const suffix = parseInt(match[2]!, 10);
      start = Math.max(0, stats.size - suffix);
      end = stats.size - 1;
    } else {
      start = match[1] ? parseInt(match[1], 10) : 0;
      end = match[2] ? parseInt(match[2], 10) : stats.size - 1;
    }

    if (
      Number.isNaN(start) ||
      Number.isNaN(end) ||
      start > end ||
      start >= stats.size
    ) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: {
          "content-range": `bytes */${stats.size}`,
        },
      });
    }

    end = Math.min(end, stats.size - 1);

    headers.set("content-range", `bytes ${start}-${end}/${stats.size}`);
    headers.set("content-length", String(end - start + 1));

    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers,
    });
  }

  headers.set("content-length", String(stats.size));

  return new Response(file, {
    status: 200,
    headers,
  });
}

export function streamDownload(
  stream: ReadableStream,
  opts: StreamDownloadOptions = {}
): Response {
  const headers = new Headers({
    "content-type": opts.contentType || "application/octet-stream",
    "cache-control": opts.cacheControl || "no-store",
  });

  if (opts.filename) {
    headers.set(
      "content-disposition",
      `attachment; filename="${opts.filename.replace(/"/g, "")}"`
    );
  }

  if (opts.size != null) {
    headers.set("content-length", String(opts.size));
  }

  return new Response(stream, {
    status: 200,
    headers,
  });
}