/**
 * @fileoverview Debugbar KT markdown rendering — `Bun.markdown` + sanitizer.
 *
 * The KT page is generated server-side from app knowledge (`formatKnowledgeMarkdown`)
 * whose interpolated values (env, plugin descriptions, route descriptions) are
 * not HTML-escaped at the source. `Bun.markdown.html()` deliberately passes raw
 * HTML through verbatim, so rendered output must be sanitized before it is
 * served to the dashboard. `sanitizeMdHtml` is a conservative allowlist
 * sanitizer: executable blocks are dropped, event handlers and `javascript:`
 * URLs are stripped, and any tag outside the allowlist is escaped to text.
 *
 * Falls back to `null` (dashboard uses the client-side mini renderer) when the
 * Bun global is unavailable — e.g. vitest's node sandbox.
 */

/** Tags the dashboard's markdown viewer may render. */
const ALLOWED_TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "code",
  "pre",
  "blockquote",
  "strong",
  "b",
  "em",
  "i",
  "a",
  "hr",
  "br",
  "span",
  "div",
  "details",
  "summary",
]);

/**
 * Sanitize HTML produced by `Bun.markdown.html()` so only safe, presentational
 * markup reaches the dashboard. Anything potentially executable or outside the
 * allowlist is removed or escaped to literal text.
 */
export function sanitizeMdHtml(html: string): string {
  return (
    html
      // Drop comments and executable blocks entirely.
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
      .replace(
        /<(iframe|object|embed|form|input|button|textarea|select|option|link|meta|base|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
        "",
      )
      // Strip event-handler attributes (onclick, onerror, …).
      .replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      // Neutralize javascript: URLs in href/src.
      .replace(/(\shref|\ssrc)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, "$1=$2#")
      // Escape any tag that isn't on the allowlist to literal text.
      .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (whole, tag: string) =>
        ALLOWED_TAGS.has(tag.toLowerCase())
          ? whole
          : whole.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
      )
  );
}

/**
 * Render markdown to sanitized HTML via `Bun.markdown.html()`. Returns `null`
 * when the Bun global (or its markdown API) is unavailable, so callers fall
 * back to the client-side renderer.
 */
export function renderMarkdownHtml(markdown: string): string | null {
  const markdownApi = (globalThis as { Bun?: { markdown?: { html?: (src: string) => string } } })
    .Bun?.markdown?.html;
  if (markdownApi === undefined) return null;
  try {
    return sanitizeMdHtml(markdownApi(markdown));
  } catch {
    return null;
  }
}
