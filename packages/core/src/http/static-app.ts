/**
 * @fileoverview Static SPA serving for compiled (AOT) apps — the single
 * production server story: the ignex binary serves the built frontend from
 * disk with the correct cache policy.
 *
 * Policy (matches what production apps need):
 * - assets in hash-oriented build directories or with content-hashed filenames
 *   are immutable — one-year browser + stale-while-revalidate caches;
 * - HTML pages and unhashed files are always revalidated (no stale window), so
 *   a just-published rebuild is never hidden by a stale browser/CDN copy;
 * - directories resolve to their `index.html`;
 * - unknown paths fall back to an SPA shell (`404.html`, else the index) so
 *   client-routed detail pages render via islands;
 * - an optional `tagsFor(path)` hook emits `Cache-Tag` headers as the
 *   extension point for tag-based CDN purges.
 *
 * Route files stay one-liners (plugin routes can also register in AOT apps):
 *
 * ```ts
 * // src/routes/[...path].get.ts
 * import { serveStaticApp } from "@ignex/core";
 * export default get((ctx) => serveStaticApp(ctx, { root: FRONTEND_DIST }));
 * ```
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { IgnexContext } from "../http/context";
import { safeJoin, sendFile } from "../http/files";

/** Options for {@link serveStaticApp}. */
export interface ServeStaticAppOptions {
  /** Absolute path to the built frontend output (served root). */
  root: string;
  /**
   * SPA shell served for unknown paths (client-routed apps). Falls back to
   * `<root>/404.html`, then `<root>/index.html`. Default: `"404.html"`.
   */
  shell?: string;
  /** Directory index filename (default `"index.html"`). */
  index?: string;
  /**
   * Paths matching this pattern receive long-lived caching. The default is
   * restricted to hash-oriented build directories and content-hashed filenames.
   */
  assetPattern?: RegExp;
  /** Browser cache seconds for assets (default one year). */
  maxAgeAsset?: number;
  /**
   * CDN purge extension point: return a tag value (e.g. `` `gigs:${id}` ``)
   * for a served page path, or null for none. Emitted as `Cache-Tag`.
   */
  tagsFor?: (relPath: string) => string | null;
}

/** Default long-cache detection requires a build directory or a content hash. */
const DEFAULT_ASSET_PATTERN = `${/^(?:_astro|_next|assets|static)\//.source}|(?:^|[.-])[a-f0-9]{8,}(?:[.-]|$)`;

/** Compiled asset patterns by source — avoids a `new RegExp` per request. */
const assetPatternCache = new Map<string, RegExp>();

const assetPatternFor = (source: string): RegExp => {
  let pattern = assetPatternCache.get(source);
  if (pattern === undefined) {
    pattern = new RegExp(source);
    assetPatternCache.set(source, pattern);
  }
  return pattern;
};

/**
 * Serve a request from a built static-frontend directory (see module docs).
 * Returns the file Response, the SPA shell for unknown paths, or a plain
 * 404 text response when nothing has been built yet.
 */
export const serveStaticApp = async (
  ctx: Pick<IgnexContext, "req" | "params">,
  options: ServeStaticAppOptions,
): Promise<Response> => {
  const index = options.index ?? "index.html";
  const shellName = options.shell ?? "404.html";
  const assetPattern = assetPatternFor(options.assetPattern?.source ?? DEFAULT_ASSET_PATTERN);
  const maxAgeAsset = options.maxAgeAsset ?? 315_36000;

  const raw = ctx.params.path;
  const rel = typeof raw === "string" && raw.length > 0 ? raw : index;
  const isAsset = assetPattern.test(rel);

  let file = safeJoin(options.root, rel);
  try {
    const st = statSync(file);
    if (st.isDirectory()) file = join(file, index);
  } catch {
    const shell = join(options.root, shellName);
    file = existsSync(shell) ? shell : join(options.root, index);
  }
  if (!existsSync(file)) {
    return new Response("Frontend not built — run your frontend build", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const res = await sendFile(file, {
    req: ctx.req,
    maxAge: isAsset ? maxAgeAsset : 0,
    swr: isAsset ? maxAgeAsset : 0, // pages: always revalidate
  });

  if (options.tagsFor !== undefined) {
    const tag = options.tagsFor(rel);
    if (tag !== null && tag !== undefined) res.headers.set("Cache-Tag", tag);
  }
  return res;
};
