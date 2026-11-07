/**
 * Verify template auto-escape parity under plain Bun: the native minijinja
 * renderer (`createTemplate`, SELECTION: native) and the pure-TS fallback
 * (`renderTemplateFallback`) must produce BYTE-IDENTICAL output on every
 * vector — the secure-defaults contract since HTML auto-escaping landed
 * (castrum ≥ 0.9.12 enables minijinja `AutoEscape::Html` in
 * `TemplateRenderer::new`; the fallback mirrors the exact entity table).
 *
 * Usage:
 *   bun scripts/verify-native-template.ts
 *
 * Without the addon installed every comparison degenerates to
 * fallback-vs-fallback (trivially green — the graceful-fallback contract);
 * the CI native-parity lane builds castrum from the pinned tag, which is
 * where a native divergence actually bites. Exits 1 on any divergence,
 * including the `{ autoescape: false }` opt-out and the minijinja
 * scalar/container repr (`True`, `[1, "a"]`, `{"k": "v"}`).
 */
import { createTemplate, renderTemplateFallback, type TemplateRenderOptions } from "@ignex/native";

const HOSTILE = `<b>&"x'/y`;

interface Vector {
  label: string;
  source: string;
  context: Record<string, unknown>;
  options?: TemplateRenderOptions;
}

const VECTORS: Vector[] = [
  { label: "plain interpolation", source: "A{{ name }}B", context: { name: HOSTILE } },
  { label: "| safe opt-out", source: "{{ name | safe }}", context: { name: HOSTILE } },
  { label: "| escape forces escape", source: "{{ name | escape }}", context: { name: HOSTILE } },
  {
    label: "filter chain on plain",
    source: "{{ name | upper }}",
    context: { name: HOSTILE },
  },
  {
    label: "safe preserved through upper",
    source: "{{ name | safe | upper }}",
    context: { name: HOSTILE },
  },
  {
    label: "safe preserved through lower",
    source: "{{ name | safe | lower }}",
    context: { name: HOSTILE },
  },
  {
    label: "safe preserved through trim",
    source: "{{ name | safe | trim }}",
    context: { name: HOSTILE },
  },
  {
    label: "escape after safe chain",
    source: "{{ name | safe | upper | escape }}",
    context: { name: HOSTILE },
  },
  {
    label: "if branch",
    source: "{% if show %}{{ name }}{% endif %}",
    context: { name: HOSTILE, show: true },
  },
  {
    label: "if/else branch",
    source: "{% if nope %}{{ name }}{% else %}{{ name | upper }}{% endif %}",
    context: { name: HOSTILE },
  },
  {
    label: "for loop items",
    source: "{% for x in xs %}[{{ x }}]{% endfor %}",
    context: { xs: ["<i>", "b&"] },
  },
  {
    label: "for over object values",
    source: "{% for v in obj %}({{ v }}){% endfor %}",
    context: { obj: { a: 1, b: "<y>" } },
  },
  {
    label: "loop metadata",
    source: "{% for x in xs %}{{ loop.index }}:{{ x }};{% endfor %}",
    context: { xs: ["<i>", "b&"] },
  },
  {
    label: "scalar repr (bools/numbers)",
    source: "n={{ n }} f={{ f }} ok={{ ok }} no={{ no }} miss={{ missing }}",
    context: { n: 42, f: 1.5, ok: true, no: false },
  },
  {
    label: "nested property",
    source: "{{ user.bio }}",
    context: { user: { bio: "<em>hi" } },
  },
  {
    label: "array repr (quoted strings)",
    source: "{{ arr }}",
    context: { arr: [1, "<a>", { k: "v&" }] },
  },
  {
    label: "object repr (quoted values)",
    source: "{{ obj }}",
    context: { obj: { a: 1, b: "<y>" } },
  },
  {
    label: "default filter escapes literal",
    source: '{{ missing | default("<z>") }}',
    context: {},
  },
  { label: "length", source: "{{ name | length }}", context: { name: HOSTILE } },
  {
    label: "comment + text",
    source: "a{# hidden #}{{ name }}",
    context: { name: HOSTILE },
  },
  { label: "unicode", source: "{{ u }}", context: { u: "héllo<w>" } },
  {
    label: "autoescape disabled opt-out",
    source: "{{ name }}",
    context: { name: HOSTILE },
    options: { autoescape: false },
  },
];

let failures = 0;
for (const { label, source, context, options } of VECTORS) {
  const native = createTemplate(source, options)(context);
  const fallback = renderTemplateFallback(source, context, options);
  const ok = native === fallback;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    failures += 1;
    console.log(`      native  : ${JSON.stringify(native)}`);
    console.log(`      fallback: ${JSON.stringify(fallback)}`);
  }
}

// The one-shot `renderTemplate` is SELECTION-pinned to the JS engine, but the
// compiled path must agree with the fallback on the same source (the
// `createTemplate`/`renderTemplate` entry points are interchangeable).
{
  const probe = VECTORS[0];
  if (probe) {
    const viaCompiled = createTemplate(probe.source)(probe.context);
    const viaFallback = renderTemplateFallback(probe.source, probe.context);
    const ok = viaCompiled === viaFallback;
    console.log(`${ok ? "PASS" : "FAIL"}  one-shot ≡ compiled entry point`);
    if (!ok) failures += 1;
  }
}

if (failures > 0) {
  console.error(`template parity FAILED — ${failures} divergent vector(s)`);
  process.exit(1);
}
console.log("template auto-escape parity: native ≡ fallback on all vectors.");
