/**
 * `markdown` — server-side KT rendering (Bun.markdown) + allowlist sanitizer.
 * The sanitizer is pure TS and is exercised directly; the Bun.markdown bridge
 * is not available in the vitest sandbox, so `renderMarkdownHtml` is asserted
 * to degrade to `null` there.
 */

import { describe, expect, it } from "vitest";
import { renderMarkdownHtml, sanitizeMdHtml } from "../src/debug/markdown";

describe("sanitizeMdHtml", () => {
  it("keeps presentational markup", () => {
    const input =
      '<h2 id="x">Title</h2><p>Hello <strong>world</strong> <code>ctx.query</code></p>' +
      "<ul><li>one</li></ul><blockquote>note</blockquote><table><tr><td>c</td></tr></table>" +
      '<a href="https://example.com">link</a><hr>';
    const out = sanitizeMdHtml(input);
    expect(out).toContain("<h2");
    expect(out).toContain("<strong>");
    expect(out).toContain("<a href=");
    expect(out).toContain("<table>");
  });

  it("drops script/style and executable blocks", () => {
    const out = sanitizeMdHtml(
      "<p>ok</p><script>alert(1)</script><style>body{display:none}</style>" +
        '<iframe src="https://evil"></iframe><form action="/x"><input></form>',
    );
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<style");
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("<form");
    expect(out).not.toContain("<input");
    expect(out).toContain("<p>ok</p>");
  });

  it("strips event-handler attributes and javascript: URLs", () => {
    const out = sanitizeMdHtml(
      '<img src="x" onerror="alert(1)"><a href="javascript:alert(1)">bad</a>' +
        '<p onclick="go()">text</p>',
    );
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("javascript:");
  });

  it("escapes unknown tags to literal text", () => {
    const out = sanitizeMdHtml("<marquee>hi</marquee><p>ok</p>");
    expect(out).not.toContain("<marquee>");
    expect(out).toContain("&lt;marquee&gt;");
    expect(out).toContain("<p>ok</p>");
  });

  it("drops HTML comments", () => {
    const out = sanitizeMdHtml("<p>a</p><!-- secret --><p>b</p>");
    expect(out).not.toContain("secret");
  });
});

describe("renderMarkdownHtml", () => {
  it("returns null when the Bun global is unavailable (vitest sandbox)", () => {
    // In the vitest node sandbox `globalThis.Bun` is absent; the bridge must
    // degrade to null so the dashboard falls back to the client renderer.
    expect(renderMarkdownHtml("# hi")).toBeNull();
  });
});
