/**
 * @fileoverview Build-time context-usage detection.
 *
 * Walks a route handler body and records which `ctx.*` members (or members of
 * destructured / aliased references to the context root) are actually used.
 * The resulting {@link ContextUsage} bitmap lets codegen emit a specialized
 * context that only carries the members the handler touches — the core AOT
 * "specialize context" optimization.
 */

import { type ContextUsage, EMPTY_USAGE } from "@ignex/shared";
import { type Expression, type Node, type Pattern, propertyName } from "./ast-types";
import { walk } from "./walk";

/**
 * Maps a context member name to the single {@link ContextUsage} flag it sets.
 * Several runtime members deliberately collapse onto one flag (e.g. `url`,
 * `path` and `method` all imply "request URL was read").
 */
const USAGE_FLAGS: Record<string, keyof ContextUsage> = {
  body: "body",
  files: "body",
  file: "file",
  params: "params",
  query: "query",
  headers: "headers",
  state: "state",
  getState: "state",
  setState: "state",
  req: "req",
  url: "url",
  path: "url",
  method: "url",
  cookie: "cookie",
  server: "server",
  set: "set",
  json: "json",
  text: "text",
  html: "html",
  redirect: "redirect",
  stream: "stream",
  empty: "empty",
  status: "status",
  sendFile: "sendFile",
  proxy: "proxy",
  forward: "forward",
  cache: "cache",
  loader: "loader",
};

/**
 * Build a map `localVariableName → contextProperty (or "__root__")` from a
 * handler's parameter list.
 *
 * Supports:
 * - `(ctx) => …`                        → ctx maps to the root
 * - `({ query, params }) => …`          → each destructured key maps to its
 *                                          own context member
 * - `(ctx, req)`                        → only the first param is the context
 *
 * Nested destructuring and rest elements are deliberately not expanded — they
 * are rare in route handlers and skipping them keeps the mapping trivial.
 */
export function buildContextMapping(params: Pattern[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(params)) return map;

  for (const param of params) {
    if (!param) continue;
    if (param.type === "Identifier") {
      map.set(param.name, "__root__");
    } else if (param.type === "ObjectPattern") {
      for (const prop of param.properties || []) {
        if (prop.type !== "Property") continue;
        const key = propertyName(prop.key);
        const local = propertyName(prop.value);
        if (key !== undefined && local !== undefined) map.set(String(local), String(key));
        // Nested destructuring not supported for DX simplicity.
      }
    }
  }
  return map;
}

const setUsageFlag = (usage: ContextUsage, prop: string | undefined): void => {
  if (!prop) return;
  const flag = USAGE_FLAGS[prop];
  if (flag) usage[flag] = true;
};

/** Context-member key as a string (numeric literal keys never map to a flag). */
const memberKey = (node: Expression | undefined): string | undefined => {
  const key = propertyName(node);
  return typeof key === "string" ? key : undefined;
};

/** Record `const b = ctx.body;`-style aliases for later member/identifier use. */
const recordAlias = (n: Node, aliases: Map<string, string>, rootNames: Set<string>): void => {
  if (
    n.type === "VariableDeclarator" &&
    n.id?.type === "Identifier" &&
    n.init?.type === "MemberExpression" &&
    n.init.object?.type === "Identifier" &&
    rootNames.has(n.init.object.name)
  ) {
    const alias = memberKey(n.init.property);
    if (alias) aliases.set(n.id.name, alias);
  }
};

/** Record `ctx.foo` / `alias.foo` / chained `ctx.req.url` member usage. */
const recordMember = (
  n: Node,
  usage: ContextUsage,
  aliases: Map<string, string>,
  rootNames: Set<string>,
): void => {
  if (n.type !== "MemberExpression") return;

  if (n.object?.type === "Identifier") {
    const name = n.object.name;
    if (rootNames.has(name)) setUsageFlag(usage, memberKey(n.property));
    if (aliases.has(name)) setUsageFlag(usage, aliases.get(name));
    return;
  }

  // Chained access rooted at the context: `ctx.req.url`. Resolve the chain to
  // its root identifier and flag the outer property. Unknown member names are
  // filtered by the USAGE_FLAGS whitelist, so ordinary chains like
  // `ctx.body.length` never set a bogus flag.
  if (n.object?.type === "MemberExpression") {
    let chain: Expression = n.object;
    while (chain.type === "MemberExpression" && chain.object?.type === "MemberExpression") {
      chain = chain.object;
    }
    if (
      chain.type === "MemberExpression" &&
      chain.object?.type === "Identifier" &&
      rootNames.has(chain.object.name)
    ) {
      setUsageFlag(usage, memberKey(n.property));
    }
  }
};

/** Record a bare alias identifier usage (e.g. `b` inside `json({ ok: b })`). */
const recordIdentifier = (n: Node, usage: ContextUsage, aliases: Map<string, string>): void => {
  if (n.type === "Identifier" && aliases.has(n.name)) {
    setUsageFlag(usage, aliases.get(n.name));
  }
};

/** Record `ctx.json(...)` / `alias.text(...)` call usage. */
const recordCall = (
  n: Node,
  usage: ContextUsage,
  aliases: Map<string, string>,
  rootNames: Set<string>,
): void => {
  if (
    n.type === "CallExpression" &&
    n.callee?.type === "MemberExpression" &&
    n.callee.object?.type === "Identifier"
  ) {
    const name = n.callee.object.name;
    if (rootNames.has(name)) setUsageFlag(usage, memberKey(n.callee.property));
    if (aliases.has(name)) setUsageFlag(usage, aliases.get(name));
  }
};

/**
 * Detect context usage inside a handler body (or function node).
 * `mapping` comes from {@link buildContextMapping}.
 */
export function detectUsage(bodyNode: Node, mapping: Map<string, string>): ContextUsage {
  const usage: ContextUsage = { ...EMPTY_USAGE };
  const rootNames = new Set<string>();
  const aliases = new Map<string, string>();

  for (const [local, prop] of mapping.entries()) {
    if (prop === "__root__") rootNames.add(local);
    else aliases.set(local, prop);
  }

  walk(bodyNode, (n) => {
    // Track aliases: `const b = ctx.body;`
    recordAlias(n, aliases, rootNames);
    // ctx.foo / alias.foo (computed access with a literal key is supported)
    recordMember(n, usage, aliases, rootNames);
    // Bare identifiers that are aliases: `json({ ok: b })` after `const b = ctx.body;`
    recordIdentifier(n, usage, aliases);
    // Call expressions: ctx.json(...) / alias.text(...)
    recordCall(n, usage, aliases, rootNames);
  });

  return usage;
}
