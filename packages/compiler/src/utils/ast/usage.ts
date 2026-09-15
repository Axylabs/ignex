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
 *
 * NOTE: members must map to the flag whose EMITTED PROPERTY is the one the
 * handler reads. Collapsing two members onto one flag (as `path`/`method` used
 * to do with `url`) means codegen emits the flag's member and not the other, so
 * the handler reads `undefined` — see `method` below.
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
  path: "path",
  method: "method",
  // The request's identity. Each forces `needsFull` rather than a specialized
  // context, because the specialized object literal cannot express them yet.
  ip: "ip",
  route: "route",
  requestId: "requestId",
  startTime: "startTime",
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
  debug: "debug",
};

/**
 * Reserved mapping key meaning "this handler uses a pattern the analyzer
 * cannot enumerate" (rest elements, nested/computed destructuring). Consumers
 * must assume FULL context usage — an under-approximation here compiles to a
 * context missing members the handler reads (silent runtime `undefined`s),
 * so unanalyzable shapes always degrade UP to the full context.
 */
export const OPAQUE_MAPPING = "__ignex_opaque__";

/**
 * Build a map `localVariableName → contextProperty (or "__root__")` from a
 * handler's parameter list.
 *
 * Supports:
 * - `(ctx) => …`                        → ctx maps to the root
 * - `({ query, params }) => …`          → each destructured key maps to its
 *                                          own context member
 * - `({ query = {} }) => …`             → defaults unwrap to the binding name
 * - `(ctx, req)`                        → only the first param is the context
 *
 * Anything the analyzer cannot enumerate (rest elements, nested or computed
 * destructuring) records {@link OPAQUE_MAPPING}, forcing full-context
 * specialization instead of silently dropping members.
 */
/** Map one destructured property, or mark the mapping opaque. */
const mapPatternProperty = (prop: Node, map: Map<string, string>): void => {
  if (prop.type !== "Property") {
    map.set(OPAQUE_MAPPING, "__all__");
    return;
  }
  const key = propertyName(prop.key);
  // `query` or `query = {}` — defaults unwrap to the bound identifier.
  const bound = prop.value?.type === "AssignmentExpression" ? prop.value.left : prop.value;
  const local = bound?.type === "Identifier" ? bound.name : undefined;
  if (key !== undefined && local !== undefined) map.set(local, String(key));
  else map.set(OPAQUE_MAPPING, "__all__");
};

/** One parameter of an ObjectPattern — rest elements force opaque. */
const mapObjectPattern = (param: Node & { type: "ObjectPattern" }, map: Map<string, string>) => {
  for (const prop of param.properties || []) {
    if (prop.type === "RestElement") {
      map.set(OPAQUE_MAPPING, "__all__");
      continue;
    }
    mapPatternProperty(prop as Node, map);
  }
};

export function buildContextMapping(params: Pattern[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(params)) return map;

  for (const param of params) {
    if (!param) continue;
    if (param.type === "Identifier") {
      map.set(param.name, "__root__");
    } else if (param.type === "ObjectPattern") {
      mapObjectPattern(param, map);
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

/** Force every usage flag (the conservative FULL-context outcome). */
const markFullUsage = (usage: ContextUsage): void => {
  for (const k of Object.keys(usage) as (keyof ContextUsage)[]) usage[k] = true;
};

/** Record a single destructured binding into the alias/root registries. */
const recordDestructuredKey = (prop: Node, aliases: Map<string, string>): "ok" | "opaque" => {
  if (prop.type === "RestElement") return "opaque";
  if (prop.type !== "Property") return "opaque";
  const key = propertyName(prop.key);
  const bound = prop.value?.type === "AssignmentExpression" ? prop.value.left : prop.value;
  const local = bound?.type === "Identifier" ? bound.name : undefined;
  if (key === undefined || local === undefined) return "opaque";
  // Only whitelist-resolvable keys matter; unknown keys are ignored by
  // setUsageFlag anyway.
  aliases.set(local, String(key));
  return "ok";
};

/** Assignment aliasing: `b = ctx.body` (alias) or `b = ctx` (re-root). */
const recordAssignmentAlias = (
  n: Node & { type: "AssignmentExpression" },
  aliases: Map<string, string>,
  rootNames: Set<string>,
  seen: Set<Node>,
): void => {
  if (n.operator !== "=" || n.left?.type !== "Identifier" || seen.has(n)) return;
  seen.add(n);
  const right = n.right as Node;
  if (right.type === "Identifier" && rootNames.has(right.name)) {
    rootNames.add(n.left.name);
    return;
  }
  if (
    right.type === "MemberExpression" &&
    right.object?.type === "Identifier" &&
    rootNames.has(right.object.name)
  ) {
    const alias = memberKey(right.property);
    if (alias) aliases.set(n.left.name, alias);
  }
};

/** Declarator rooted at the context: `const b = ctx[.member]` or `const {…} = ctx`. */
const recordDeclarator = (
  n: Node & { type: "VariableDeclarator" },
  usage: ContextUsage,
  aliases: Map<string, string>,
  rootNames: Set<string>,
): void => {
  if (!n.init || !n.id) return;

  const init = n.init as Node;
  const initIsRoot = init.type === "Identifier" && rootNames.has((init as { name: string }).name);
  const initRootMember =
    init.type === "MemberExpression" &&
    init.object?.type === "Identifier" &&
    rootNames.has(init.object.name);

  if (!initIsRoot && !initRootMember) return;

  // `const b = ctx;` → b is another name for the whole context root.
  if (n.id.type === "Identifier" && initIsRoot) {
    rootNames.add(n.id.name);
    return;
  }
  // `const b = ctx.body;` → plain member alias (existing behavior).
  if (n.id.type === "Identifier" && initRootMember) {
    const alias = memberKey(init.property);
    if (alias) aliases.set(n.id.name, alias);
    return;
  }
  // Destructuring straight off the root: `const { body, query: q } = ctx;`
  if (n.id.type === "ObjectPattern" && initIsRoot) {
    for (const prop of n.id.properties ?? []) {
      if (recordDestructuredKey(prop as Node, aliases) === "opaque") {
        markFullUsage(usage);
        return;
      }
    }
  }
};

/**
 * Track context-rooted bindings introduced INSIDE the body:
 * - `const b = ctx;`            → b becomes an additional root name
 * - `const b = ctx.body;`       → alias
 * - `const { body } = ctx;`     → per-key aliases
 * - `b = ctx.body;`             → assignment aliasing
 */
const recordRootBinding = (
  n: Node,
  usage: ContextUsage,
  aliases: Map<string, string>,
  rootNames: Set<string>,
  seen: Set<Node>,
): void => {
  if (n.type === "AssignmentExpression") {
    recordAssignmentAlias(n, aliases, rootNames, seen);
    return;
  }
  if (n.type === "VariableDeclarator") {
    recordDeclarator(n, usage, aliases, rootNames);
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

/** Is this expression the context root itself (or another name bound to it)? */
const isRootNode = (node: Node | undefined, rootNames: Set<string>): boolean =>
  node?.type === "Identifier" && rootNames.has((node as { name: string }).name);

/** Is this argument position carrying the context root out of the analyzer? */
const argumentEscapes = (arg: Node | undefined, rootNames: Set<string>): boolean => {
  if (!arg) return false;
  if (arg.type === "SpreadElement") {
    return isRootNode((arg as { argument?: Node }).argument, rootNames);
  }
  if (isRootNode(arg, rootNames)) return true;
  // `attach({ ...ctx })` enumerates the root's members, so it escapes exactly
  // as `attach(ctx)` does — the callee may read a member we did not emit.
  if (arg.type === "ObjectExpression") {
    for (const prop of (arg as { properties?: Node[] }).properties ?? []) {
      if (
        prop?.type === "SpreadElement" &&
        isRootNode((prop as { argument?: Node }).argument, rootNames)
      ) {
        return true;
      }
    }
  }
  return false;
};

/**
 * The context root ESCAPING into something the analyzer cannot inspect:
 * `helper(ctx)`, `helper(...ctx)`, `attach({ ...ctx })`, `box.ctx = ctx`.
 *
 * Only the handler body is analyzed, so a callee in another module — or a
 * same-file helper the walker does not descend into — is opaque and may read
 * ANY member. Under-approximating here emits a specialized context that is
 * missing the members that callee reads, i.e. silent runtime `undefined`s:
 * the exact failure {@link OPAQUE_MAPPING} exists to prevent. An escape
 * therefore degrades UP to the full context.
 */
const recordEscape = (n: Node, usage: ContextUsage, rootNames: Set<string>): void => {
  if (n.type === "CallExpression" || n.type === "NewExpression") {
    for (const arg of (n as { arguments?: Node[] }).arguments ?? []) {
      if (argumentEscapes(arg, rootNames)) {
        markFullUsage(usage);
        return;
      }
    }
    return;
  }
  // Storing the root somewhere untracked: `box.ctx = ctx`, `slots[0] = ctx`.
  if (n.type === "AssignmentExpression") {
    const assign = n as Node & { type: "AssignmentExpression"; left?: Node; right?: Node };
    if (assign.left?.type !== "Identifier" && isRootNode(assign.right, rootNames)) {
      markFullUsage(usage);
    }
  }
};

/**
 * Detect context usage inside a handler body (or function node).
 * `mapping` comes from {@link buildContextMapping}.
 */
export function detectUsage(bodyNode: Node, mapping: Map<string, string>): ContextUsage {
  const usage: ContextUsage = { ...EMPTY_USAGE };

  // Unanalyzable parameter shape — the only sound outcome is full context.
  if (mapping.has(OPAQUE_MAPPING)) {
    markFullUsage(usage);
    return usage;
  }

  const rootNames = new Set<string>();
  const aliases = new Map<string, string>();
  const seen = new Set<Node>();

  for (const [local, prop] of mapping.entries()) {
    if (prop === "__root__") rootNames.add(local);
    else aliases.set(local, prop);
  }

  walk(bodyNode, (n) => {
    // Track root bindings introduced in the body: aliases, re-roots,
    // destructuring off ctx, and assignment aliasing.
    recordRootBinding(n, usage, aliases, rootNames, seen);
    // ctx.foo / alias.foo (computed access with a literal key is supported)
    recordMember(n, usage, aliases, rootNames);
    // Bare identifiers that are aliases: `json({ ok: b })` after `const b = ctx.body;`
    recordIdentifier(n, usage, aliases);
    // Call expressions: ctx.json(...) / alias.text(...)
    recordCall(n, usage, aliases, rootNames);
    // The root handed to a callee we cannot inspect: `helper(ctx)`
    recordEscape(n, usage, rootNames);
  });

  return usage;
}
