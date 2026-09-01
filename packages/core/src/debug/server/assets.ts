/**
 * @fileoverview Dashboard asset serving — the HTML shell, the bundled SPA
 * (`app.js`) and its stylesheet (`app.css`), precomputed once per mount.
 *
 * Hardening/perf notes:
 * - The SPA bundle is content-hashed at generation time; responses carry that
 *   hash as a strong ETag and answer `If-None-Match` with 304 (a dev-tool
 *   reload re-sends ~60 KiB instead).
 * - The HTML shell ships a strict CSP (`default-src 'none'` + same-origin
 *   script/style/connect + data: images) so even XSS in a rendered panel
 *   cannot load remote resources or inline scripts.
 * - All strings are computed once per plugin instance — per-request cost is a
 *   header check and one Response construction.
 */

import {
  DEBUGBAR_CLIENT_CSS,
  DEBUGBAR_CLIENT_HASH,
  DEBUGBAR_CLIENT_JS,
} from "../dashboard-client.gen";
import { html as htmlResponse, jsResponse } from "../respond";

/**
 * Strict CSP for the dashboard shell: scripts locked to same-origin files
 * (no inline script, no remote), images data:-only. Style attributes remain
 * allowed ('unsafe-inline' via style-src-attr fallback) because the SPA uses
 * them for measured geometry (waterfall bar widths, tree indents); stylesheet
 * LOADS are still restricted to same-origin.
 */
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'self'";

export interface AssetServer {
  /** `GET {path}/` — the HTML shell. */
  page: () => Response;
  /** `GET {path}/app.js` — the bundled SPA (ETag-cached). */
  js: (ifNoneMatch: string | null) => Response;
  /** `GET {path}/app.css` — the stylesheet (ETag-cached). */
  css: (ifNoneMatch: string | null) => Response;
}

/**
 * Build the dashboard shell for a mount path. Kept here (instead of a separate
 * template module) so nav entries and asset URLs stay adjacent to the server
 * that serves them; the view registry in the client is the functional mirror.
 */
const buildShell = (base: string): string => `<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>IgnEx Debugbar</title>
    <link
      rel="icon"
      href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E⚡%3C/text%3E%3C/svg%3E"
    />
    <link rel="stylesheet" href="${base}/app.css" />
  </head>
  <body>
    <!-- The SPA mounts itself: topbar/nav/status bar are built by app.ts -->
    <script src="${base}/app.js" data-base="${base}"></script>
  </body>
</html>`;

/** Create the asset server bound to one dashboard mount path. */
export const createAssetServer = (mountPath: string): AssetServer => {
  const base = mountPath.replace(/\/$/, "");
  const shell = buildShell(base);
  return {
    page: (): Response => {
      const res = htmlResponse(shell);
      res.headers.set("content-security-policy", CSP);
      res.headers.set("x-content-type-options", "nosniff");
      res.headers.set("referrer-policy", "no-referrer");
      return res;
    },
    js: (ifNoneMatch): Response => {
      if (ifNoneMatch === `"${DEBUGBAR_CLIENT_HASH}"`) {
        return new Response(null, { status: 304, headers: { etag: `"${DEBUGBAR_CLIENT_HASH}"` } });
      }
      const res = jsResponse(DEBUGBAR_CLIENT_JS);
      res.headers.set("etag", `"${DEBUGBAR_CLIENT_HASH}"`);
      res.headers.set("cache-control", "no-cache");
      res.headers.set("x-content-type-options", "nosniff");
      return res;
    },
    css: (ifNoneMatch): Response => {
      if (ifNoneMatch === `"${DEBUGBAR_CLIENT_HASH}"`) {
        return new Response(null, { status: 304, headers: { etag: `"${DEBUGBAR_CLIENT_HASH}"` } });
      }
      const res = new Response(DEBUGBAR_CLIENT_CSS, {
        status: 200,
        headers: {
          "content-type": "text/css; charset=utf-8",
          "cache-control": "no-cache",
          etag: `"${DEBUGBAR_CLIENT_HASH}"`,
        },
      });
      return res;
    },
  };
};
