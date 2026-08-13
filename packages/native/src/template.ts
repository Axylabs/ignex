/**
 * Template rendering (native minijinja when available).
 *
 * The fallback is a small Jinja-like engine supporting the common subset:
 * `{{ expr }}` interpolation with dot/bracket access + filters, `{% if %}`
 * /`{% elif %}`/`{% else %}`/`{% endif %}`, `{% for x in list %}`/`{% endfor %}`
 * with a `loop` object, and `{# comments #}`. Complex Jinja features are
 * available only through the native addon.
 */
import { nativeFor } from "./runtime";
import { fromBytes } from "./util";

interface NativeTemplateRenderer {
  render(context: unknown): Uint8Array;
}

/**
 * Build a compiled native renderer via the `createTemplateRenderer` factory
 * (the surface the `rust` client exposes — the raw `TemplateRenderer` class is
 * not exported). Returns `null` when native is unavailable, so the fallback
 * engine is always a valid path.
 */
const createNativeRenderer = (
  source: string,
  op: "createTemplate" | "renderTemplate",
): NativeTemplateRenderer | null => {
  const n = nativeFor(op);
  if (!n || typeof n.TemplateRenderer !== "function") return null;
  try {
    return new n.TemplateRenderer(source);
  } catch {
    return null;
  }
};

/** Render a template string with the given context (JSON-serializable). */
export const renderTemplate = (source: string, context: unknown): string => {
  const renderer = createNativeRenderer(source, "renderTemplate");
  if (renderer) return fromBytes(renderer.render(context));
  return renderTemplateFallback(source, context);
};

/** Create a compiled template renderer (reusable, lower per-render cost). */
export const createTemplate = (source: string): ((context: Record<string, unknown>) => string) => {
  const renderer = createNativeRenderer(source, "createTemplate");
  if (renderer) return (context) => fromBytes(renderer.render(context));
  return (context) => renderTemplateFallback(source, context);
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

const htmlEscape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const applyFilter = (filterExpr: string, value: unknown, ctx: Record<string, unknown>): unknown => {
  const m = /^([A-Za-z_][\w$]*)(?:\((.*)\))?$/.exec(filterExpr.trim());
  if (!m) return value;
  const name = m[1];
  const args = m[2]
    ? m[2]
        .split(",")
        .map((a) => a.trim())
        .map((a) => evaluate(a, ctx))
    : [];
  switch (name) {
    case "upper":
      return typeof value === "string" ? value.toUpperCase() : value;
    case "lower":
      return typeof value === "string" ? value.toLowerCase() : value;
    case "trim":
      return typeof value === "string" ? value.trim() : value;
    case "capitalize":
      return typeof value === "string" && value.length > 0
        ? value[0]?.toUpperCase() + value.slice(1)
        : value;
    case "escape":
      return htmlEscape(String(value ?? ""));
    case "length":
      return typeof value === "string" ? value.length : Array.isArray(value) ? value.length : 0;
    case "default":
      return value ?? args[0] ?? "";
    case "json":
      return JSON.stringify(value);
    default:
      return value;
  }
};

const evaluate = (expr: string, ctx: Record<string, unknown>): unknown => {
  const parts = expr.split("|").map((s) => s.trim());
  let value = evaluateAtom(parts[0] ?? "", ctx);
  for (const filter of parts.slice(1)) value = applyFilter(filter, value, ctx);
  return value;
};

const truthy = (v: unknown): boolean => {
  if (v == null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
};

const renderNodes = (nodes: Node[], ctx: Record<string, unknown>): string => {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += node.value;
        break;
      case "expr": {
        const v = evaluate(node.value, ctx);
        out += v == null ? "" : String(v);
        break;
      }
      case "if": {
        const branch = node.branches.find((b) => truthy(evaluate(b.cond, ctx)));
        out += renderNodes(branch ? branch.body : node.elseBody, ctx);
        break;
      }
      case "for": {
        const iterable = evaluate(node.iterable, ctx);
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
          out += renderNodes(node.body, scope);
        });
        break;
      }
    }
  }
  return out;
};

/**
 * Minimal Jinja-like fallback renderer (see module docstring for the subset).
 */
export const renderTemplateFallback = (source: string, context: unknown): string => {
  const tokens = tokenizeRaw(source);
  const { nodes } = parseBlock(tokens, 0, new Set());
  return renderNodes(nodes, (context ?? {}) as Record<string, unknown>);
};
