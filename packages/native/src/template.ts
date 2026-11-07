/**
 * Template rendering (native minijinja when available).
 *
 * The fallback is a small Jinja-like engine supporting the common subset:
 * `{{ expr }}` interpolation with dot/bracket access + filters, `{% if %}`
 * /`{% elif %}`/`{% else %}`/`{% endif %}`, `{% for x in list %}`/`{% endfor %}`
 * with a `loop` object, and `{# comments #}`. Complex Jinja features are
 * available only through the native addon.
 *
 * Security contract: `{{ }}` interpolation is HTML auto-escaped by DEFAULT in
 * both engines with the exact minijinja `AutoEscape::Html` table (`< > & " ' /`)
 * — the fallback mirrors it byte for byte, so native↔fallback renders are
 * identical (pinned by `scripts/verify-native-template.ts`). The `| safe`
 * filter opts a value out; `{ autoescape: false }` disables the whole gate.
 */
import { getFfiInstances, growExact } from "./ffi";
import { nativeFor } from "./runtime";
import { encoder, fromBytes } from "./util";

/** Per-renderer template options (mirrors the castrum addon constructor). */
export interface TemplateRenderOptions {
  /** Disable HTML auto-escaping of `{{ }}` interpolation (default: on). */
  autoescape?: boolean;
}

interface NativeTemplateRenderer {
  render(context: unknown): Uint8Array;
}

/** Hard cap for template render output (needed-size convention). */
const MAX_TEMPLATE_OUTPUT = 64 * 1024 * 1024;

/**
 * Build a compiled native renderer via the `createTemplateRenderer` factory
 * (the surface the `rust` client exposes — the raw `TemplateRenderer` class is
 * not exported). Returns `null` when native is unavailable, so the fallback
 * engine is always a valid path.
 */
const createNativeRenderer = (
  source: string,
  op: "createTemplate" | "renderTemplate",
  options?: TemplateRenderOptions,
): NativeTemplateRenderer | null => {
  const n = nativeFor(op);
  if (!n || typeof n.TemplateRenderer !== "function") return null;
  try {
    const inst = new n.TemplateRenderer(source, options ?? null);
    // Opaque-handle C-ABI fast path — the per-call `render` crossing drops from
    // ~1684ns (NAPI object marshal) to ~610ns (C-ABI pre-serialized JSON
    // context) on the compiled template (bench 2026-08-16; null handle → NAPI).
    const ffiInst = getFfiInstances();
    const inner = ffiInst ? Number(inst.innerPtr()) : 0;
    return {
      render(context) {
        if (inner && ffiInst) {
          // C-ABI takes PRE-SERIALIZED JSON context (napi marshals the object
          // itself). Needed-size convention → growExact (exact retry once).
          const ctxBytes = encoder.encode(JSON.stringify(context));
          return growExact(
            (out) => ffiInst.templateRender(inner, ctxBytes, out),
            ctxBytes.length * 4 + 64,
            MAX_TEMPLATE_OUTPUT,
            "template render failed",
          );
        }
        return inst.render(context);
      },
    };
  } catch {
    return null;
  }
};

/** Render a template string with the given context (JSON-serializable). */
export const renderTemplate = (
  source: string,
  context: unknown,
  options?: TemplateRenderOptions,
): string => {
  const renderer = createNativeRenderer(source, "renderTemplate", options);
  if (renderer) return fromBytes(renderer.render(context));
  return renderTemplateFallback(source, context, options);
};

/** Create a compiled template renderer (reusable, lower per-render cost). */
export const createTemplate = (
  source: string,
  options?: TemplateRenderOptions,
): ((context: Record<string, unknown>) => string) => {
  const renderer = createNativeRenderer(source, "createTemplate", options);
  if (renderer) return (context) => fromBytes(renderer.render(context));
  return (context) => renderTemplateFallback(source, context, options);
};

// ── Fallback engine ─────────────────────────────────────────────

type Node =
  | { type: "text"; value: string }
  | { type: "expr"; value: string }
  | { type: "if"; branches: Array<{ cond: string; body: Node[] }>; elseBody: Node[] }
  | { type: "for"; variable: string; iterable: string; body: Node[] };

interface RawToken {
  kind: "text" | "expr" | "tag" | "comment";
  value: string;
}

const TOKEN_RE = /(\{\{.*?\}\}|\{%.*?%\}|\{#.*?#\})/s;

const tokenizeRaw = (source: string): RawToken[] => {
  const parts = source.split(TOKEN_RE);
  const tokens: RawToken[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("{{")) tokens.push({ kind: "expr", value: part.slice(2, -2).trim() });
    else if (part.startsWith("{%")) tokens.push({ kind: "tag", value: part.slice(2, -2).trim() });
    else if (part.startsWith("{#")) tokens.push({ kind: "comment", value: "" });
    else tokens.push({ kind: "text", value: part });
  }
  return tokens;
};

/** Parse an `if`/`elif`/`else`/`endif` block (recursive over nested blocks). */
const parseIf = (tokens: RawToken[], start: number, tag: string): { node: Node; next: number } => {
  const ifMatch = /^if\s+(.+)$/s.exec(tag);
  const thenResult = parseBlock(tokens, start + 1, new Set(["else", "elif", "endif"]));
  const branches: Array<{ cond: string; body: Node[] }> = [
    { cond: (ifMatch?.[1] ?? "").trim(), body: thenResult.nodes },
  ];
  let elseBody: Node[] = [];

  let next = thenResult.next;
  let closed = false;

  while (next < tokens.length && tokens[next]?.kind === "tag") {
    const t2 = tokens[next]?.value.trim() ?? "";
    const head2 = t2.split(/\s+/)[0] ?? "";
    if (head2 === "endif") {
      next++;
      closed = true;
      break;
    }
    if (head2 === "else") {
      const elseResult = parseBlock(tokens, next + 1, new Set(["endif"]));
      elseBody = elseResult.nodes;
      next = elseResult.next;
      if (next < tokens.length && /^endif$/.test(tokens[next]?.value.trim() ?? "")) next++;
      closed = true;
      break;
    }
    if (head2 === "elif") {
      const cond = /^elif\s+(.+)$/s.exec(t2)?.[1]?.trim() ?? "";
      const sub = parseBlock(tokens, next + 1, new Set(["else", "elif", "endif"]));
      branches.push({ cond, body: sub.nodes });
      next = sub.next;
      continue;
    }
    break;
  }

  if (!closed) {
    // Unclosed if: treat remaining as else-body (defensive).
    elseBody = parseBlock(tokens, next, new Set()).nodes;
    next = tokens.length;
  }

  return { node: { type: "if", branches, elseBody }, next };
};

/** Parse a `for … in …`/`endfor` block (recursive over nested blocks). */
const parseFor = (tokens: RawToken[], start: number, tag: string): { node: Node; next: number } => {
  const forMatch = /^for\s+(\w+)\s+in\s+(.+)$/s.exec(tag);
  const bodyResult = parseBlock(tokens, start + 1, new Set(["endfor"]));
  let next = bodyResult.next;
  if (next < tokens.length && /^endfor$/.test(tokens[next]?.value.trim() ?? "")) next++;
  return {
    node: {
      type: "for",
      variable: forMatch?.[1] ?? "",
      iterable: (forMatch?.[2] ?? "").trim(),
      body: bodyResult.nodes,
    },
    next,
  };
};

const parseBlock = (
  tokens: RawToken[],
  index: number,
  endTags: ReadonlySet<string>,
): { nodes: Node[]; next: number } => {
  const nodes: Node[] = [];
  let i = index;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === undefined) break;
    if (t.kind === "text") {
      nodes.push({ type: "text", value: t.value });
      i++;
      continue;
    }
    if (t.kind === "expr") {
      nodes.push({ type: "expr", value: t.value });
      i++;
      continue;
    }
    if (t.kind === "comment") {
      i++;
      continue;
    }

    const tag = t.value.trim();
    const head = tag.split(/\s+/)[0] ?? "";
    if (endTags.has(head)) return { nodes, next: i };

    if (/^if\s+/.test(tag)) {
      const parsed = parseIf(tokens, i, tag);
      nodes.push(parsed.node);
      i = parsed.next;
      continue;
    }

    if (/^for\s+\w+\s+in\s+/.test(tag)) {
      const parsed = parseFor(tokens, i, tag);
      nodes.push(parsed.node);
      i = parsed.next;
      continue;
    }

    // Unknown tag → no-op.
    i++;
  }
  return { nodes, next: i };
};

const evaluateAtom = (atom: string, ctx: Record<string, unknown>): unknown => {
  if (atom === "true") return true;
  if (atom === "false") return false;
  if (atom === "none" || atom === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(atom)) return Number(atom);
  if (atom.length >= 2 && atom.startsWith('"') && atom.endsWith('"')) return atom.slice(1, -1);
  if (atom.length >= 2 && atom.startsWith("'") && atom.endsWith("'")) return atom.slice(1, -1);
  return resolvePath(atom, ctx);
};

const resolvePath = (pathExpr: string, ctx: Record<string, unknown>): unknown => {
  const m = /^([A-Za-z_][\w$]*)(.*)$/.exec(pathExpr.trim());
  if (!m) return undefined;
  const root = m[1];
  if (root === undefined) return undefined;
  let value: unknown = ctx[root];
  const rest = m[2]?.trim();
  if (!rest) return value;
  const re = /\.([A-Za-z_$][\w$]*)|\["([^"]*)"\]|\['([^']*)'\]|\[(\d+)\]/g;
  let match: RegExpExecArray | null = re.exec(rest);
  while (match !== null) {
    const key: string | number = match[1] ?? match[2] ?? match[3] ?? Number(match[4]);
    if (value == null) return undefined;
    value = (value as Record<string | number, unknown>)[key];
    match = re.exec(rest);
  }
  return value;
};

/**
 * HTML auto-escape table — the exact minijinja `AutoEscape::Html` entities
 * (`&lt; &gt; &amp; &quot; &#x27; &#x2f;`), so native and fallback renders
 * stay byte-identical. `&` is replaced first so the introduced entities are
 * never re-escaped.
 */
const htmlEscape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/\//g, "&#x2f;");

/**
 * Safe-string marker — a value that must NOT be auto-escaped at render time
 * (what minijinja's `safe` filter produces). A symbol-keyed frozen wrapper:
 * filters that transform strings drop the mark, exactly like minijinja.
 */
const SAFE: unique symbol = Symbol("ignex.template.safe");

interface SafeString {
  readonly [SAFE]: true;
  readonly value: string;
}

const markSafe = (value: string): SafeString => ({ [SAFE]: true, value });

const isSafe = (value: unknown): value is SafeString =>
  typeof value === "object" && value !== null && SAFE in value;

/** Unwrap a safe string for string transformation (safety is lost). */
const unwrap = (value: unknown): unknown => (isSafe(value) ? value.value : value);

/**
 * Stringify a value the way minijinja prints it, so native and fallback
 * renders are byte-identical: Python-repr style for containers (`True`,
 * `[1, "a"]`, `{"k": "v"}`) — strings INSIDE containers are double-quoted,
 * top-level strings render raw. (Exotic float magnitudes keep JS formatting
 * — a documented divergence outside JSON round-trip values.)
 */
const stringifyValue = (value: unknown, inContainer = false): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return inContainer ? JSON.stringify(value) : value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stringifyValue(item, true)).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${JSON.stringify(key)}: ${stringifyValue(item, true)}`)
      .join(", ")}}`;
  }
  return String(value);
};

/**
 * Apply a string transform, preserving a safe mark (minijinja semantics:
 * `upper` on a safe string stays safe; on a plain string returns plain).
 */
const transformPreserveSafe = (value: unknown, transform: (raw: string) => string): unknown => {
  const raw = unwrap(value);
  if (typeof raw !== "string") return raw;
  const out = transform(raw);
  return isSafe(value) ? markSafe(out) : out;
};

/** The fallback filter table (see the module docstring for the subset). */
const FILTERS: Record<string, (value: unknown, args: unknown[]) => unknown> = {
  upper: (value) => transformPreserveSafe(value, (raw) => raw.toUpperCase()),
  lower: (value) => transformPreserveSafe(value, (raw) => raw.toLowerCase()),
  trim: (value) => transformPreserveSafe(value, (raw) => raw.trim()),
  capitalize: (value) =>
    transformPreserveSafe(value, (raw) =>
      raw.length > 0 ? raw.charAt(0).toUpperCase() + raw.slice(1) : raw,
    ),
  // `safe` marks the stringified value as trusted — auto-escaping skips it
  // (minijinja `safe` semantics).
  safe: (value) => markSafe(stringifyValue(unwrap(value))),
  // `escape` escapes once and marks the result safe, so a later auto-escape
  // pass never double-escapes (minijinja `escape` semantics — it escapes
  // with HTML rules even when auto-escape is disabled, and it trusts values
  // that are already safe).
  escape: (value) => (isSafe(value) ? value : markSafe(htmlEscape(stringifyValue(unwrap(value))))),
  length: (value) => {
    const raw = unwrap(value);
    return typeof raw === "string" ? raw.length : Array.isArray(raw) ? raw.length : 0;
  },
  // `default` returns the value itself, so a safe value stays safe.
  default: (value, args) => value ?? args[0] ?? "",
  json: (value) => JSON.stringify(unwrap(value)),
};

const applyFilter = (filterExpr: string, value: unknown, ctx: Record<string, unknown>): unknown => {
  const m = /^([A-Za-z_][\w$]*)(?:\((.*)\))?$/.exec(filterExpr.trim());
  const handler = m === null ? undefined : FILTERS[m[1] ?? ""];
  if (m === null || handler === undefined) return value;
  const args = m[2] ? m[2].split(",").map((a) => evaluate(a.trim(), ctx)) : [];
  return handler(value, args);
};

const evaluate = (expr: string, ctx: Record<string, unknown>): unknown => {
  const parts = expr.split("|").map((s) => s.trim());
  let value = evaluateAtom(parts[0] ?? "", ctx);
  for (const filter of parts.slice(1)) value = applyFilter(filter, value, ctx);
  return value;
};

const truthy = (raw: unknown): boolean => {
  const v = unwrap(raw);
  if (v == null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
};

const renderNodes = (nodes: Node[], ctx: Record<string, unknown>, autoescape: boolean): string => {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += node.value;
        break;
      case "expr": {
        const v = evaluate(node.value, ctx);
        if (v == null) break;
        if (isSafe(v)) {
          out += v.value;
        } else {
          const raw = stringifyValue(v);
          out += autoescape ? htmlEscape(raw) : raw;
        }
        break;
      }
      case "if": {
        const branch = node.branches.find((b) => truthy(evaluate(b.cond, ctx)));
        out += renderNodes(branch ? branch.body : node.elseBody, ctx, autoescape);
        break;
      }
      case "for": {
        const iterable = unwrap(evaluate(node.iterable, ctx));
        const items: Array<[unknown, unknown]> = Array.isArray(iterable)
          ? iterable.map((item, i) => [item, i] as [unknown, unknown])
          : iterable != null && typeof iterable === "object"
            ? Object.entries(iterable as Record<string, unknown>)
            : [];
        items.forEach(([item], index) => {
          const scope: Record<string, unknown> = {
            ...ctx,
            [node.variable]: item,
            loop: {
              index: index + 1,
              index0: index,
              first: index === 0,
              last: index === items.length - 1,
              length: items.length,
            },
          };
          out += renderNodes(node.body, scope, autoescape);
        });
        break;
      }
    }
  }
  return out;
};

/**
 * Minimal Jinja-like fallback renderer (see module docstring for the subset).
 * HTML auto-escapes `{{ }}` interpolation unless disabled via
 * `options.autoescape` or opted out per value with `| safe`.
 */
export const renderTemplateFallback = (
  source: string,
  context: unknown,
  options?: TemplateRenderOptions,
): string => {
  const tokens = tokenizeRaw(source);
  const { nodes } = parseBlock(tokens, 0, new Set());
  const autoescape = options?.autoescape ?? true;
  return renderNodes(nodes, (context ?? {}) as Record<string, unknown>, autoescape);
};
