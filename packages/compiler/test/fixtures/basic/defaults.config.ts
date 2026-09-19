// App config with declared static response headers (`server.headers`). Used by
// `static-defaults-passthrough.test.ts` to pin that the compiler bakes them into
// `__DEFAULT_HEADERS` AND applies them on the non-`__withBody` paths (raw
// Response, 404/405, OPTIONS, errors). No plugins/lifecycle, so the build stays
// on the specialized/hoisted path.
export const server = {
  port: 3000,
  headers: {
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  },
};
