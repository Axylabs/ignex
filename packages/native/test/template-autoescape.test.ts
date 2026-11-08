/**
 * Template auto-escape security contract (pinning tests).
 *
 * `{{ }}` interpolation is HTML auto-escaped by DEFAULT in both engines with
 * the exact minijinja `AutoEscape::Html` entity table; `| safe` opts a value
 * out (and the mark survives string transforms), `| escape` escapes once and
 * never double-escapes, `{ autoescape: false }` disables the gate. Native↔
 * fallback byte parity is pinned by `scripts/verify-native-template.ts`
 * (plain Bun); these tests pin the fallback semantics themselves (vitest runs
 * the fallback engine).
 */
import { describe, expect, it } from "vitest";
import { createTemplate, renderTemplateFallback } from "../src/template";

const HOSTILE = `<img src=x onerror="alert('1')">`;

describe("template auto-escape (secure default)", () => {
  it("escapes hostile interpolation by default", () => {
    expect(renderTemplateFallback("A{{ name }}B", { name: HOSTILE })).toBe(
      "A&lt;img src=x onerror=&quot;alert(&#x27;1&#x27;)&quot;&gt;B",
    );
  });

  it("passes clean text through unchanged", () => {
    expect(renderTemplateFallback("Hello {{ name }}!", { name: "world" })).toBe("Hello world!");
  });

  it("escapes every character of the minijinja HTML table", () => {
    expect(renderTemplateFallback("{{ c }}", { c: `<>&"'/'` })).toBe(
      "&lt;&gt;&amp;&quot;&#x27;&#x2f;&#x27;",
    );
  });

  it("escapes inside if branches and for loops", () => {
    expect(
      renderTemplateFallback("{% if show %}{{ name }}{% endif %}", { name: "<x>", show: true }),
    ).toBe("&lt;x&gt;");
    expect(
      renderTemplateFallback("{% for x in xs %}[{{ x }}]{% endfor %}", { xs: ["<i>", "b&"] }),
    ).toBe("[&lt;i&gt;][b&amp;]");
  });

  it("renders scalar values Python-repr style (native parity)", () => {
    expect(
      renderTemplateFallback("{{ ok }}/{{ no }}/{{ n }}/{{ f }}", {
        ok: true,
        no: false,
        n: 42,
        f: 1.5,
      }),
    ).toBe("True/False/42/1.5");
  });

  it("renders containers minijinja-style (quoted inner strings, escaped)", () => {
    expect(renderTemplateFallback("{{ arr }}", { arr: [1, "a"] })).toBe("[1, &quot;a&quot;]");
    expect(renderTemplateFallback("{{ obj }}", { obj: { k: "v", n: 2 } })).toBe(
      "{&quot;k&quot;: &quot;v&quot;, &quot;n&quot;: 2}",
    );
    expect(renderTemplateFallback("{{ missing }}", {})).toBe("");
  });

  describe("| safe", () => {
    it("opts a value out of escaping", () => {
      expect(renderTemplateFallback("{{ name | safe }}", { name: "<b>hi</b>" })).toBe("<b>hi</b>");
    });

    it("survives string transforms (minijinja semantics)", () => {
      expect(renderTemplateFallback("{{ name | safe | upper }}", { name: "<b>" })).toBe("<B>");
      expect(renderTemplateFallback("{{ name | safe | trim }}", { name: " <b> " })).toBe("<b>");
    });

    it("makes | escape a no-op (minijinja: escape trusts safe values)", () => {
      expect(renderTemplateFallback("{{ name | safe | escape }}", { name: "<b>" })).toBe("<b>");
    });
  });

  describe("| escape", () => {
    it("escapes explicitly and never double-escapes", () => {
      expect(renderTemplateFallback("{{ name | escape }}", { name: "<b>&" })).toBe(
        "&lt;b&gt;&amp;",
      );
    });

    it("marks the result safe so auto-escape skips it", () => {
      expect(renderTemplateFallback("x{{ name | escape }}x", { name: "<b>" })).toBe("x&lt;b&gt;x");
    });
  });

  describe("autoescape: false", () => {
    it("renders raw", () => {
      const src = "{{ name }}";
      expect(renderTemplateFallback(src, { name: HOSTILE }, { autoescape: false })).toBe(HOSTILE);
      expect(renderTemplateFallback(src, { name: HOSTILE })).not.toBe(HOSTILE);
    });
  });

  it("does not allow prototype keys to smuggle markup", () => {
    // A `__proto__` key in the context must not become a reachable property.
    const ctx = JSON.parse('{"__proto__": {"name": "<pwned>"}}') as Record<string, unknown>;
    expect(renderTemplateFallback("{{ name }}", ctx)).toBe("");
  });
});

describe("createTemplate (compiled path)", () => {
  // The compiled path only auto-escapes on an addon carrying the 0.9.12
  // template hardening; CI quality lanes resolve the registry addon, which
  // can lag the CASTRUM_REF pin until a release lands. Probe the capability
  // instead of hard-failing — the addon-freshness parity contract itself is
  // `scripts/verify-native-template.ts` (built from the pinned CASTRUM_REF).
  const compiledEscapesByDefault = (() => {
    try {
      return createTemplate("{{ name }}")({ name: "<x>" }) === "&lt;x&gt;";
    } catch {
      return false;
    }
  })();

  it.skipIf(!compiledEscapesByDefault)("auto-escapes on each render", () => {
    const tpl = createTemplate("{{ name }}");
    expect(tpl({ name: "<x>" })).toBe("&lt;x&gt;");
    expect(tpl({ name: "ok" })).toBe("ok");
  });
});
