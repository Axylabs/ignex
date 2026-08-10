/**
 * @fileoverview Minimal, parser-agnostic AST type model.
 *
 * The compiler's AST layer must work with the output of several parsers
 * (`oxc-parser`, `Bun.parse`, `Bun.Transpiler`) whose node shapes differ in
 * the field names they use for source offsets and some literal kinds. This
 * module defines a small, curated structural model — a discriminated union
 * over the node kinds the analyzer actually consumes — that stays compatible
 * with all of them:
 *
 * - `type` is the ESTree-compatible node-kind discriminant emitted by every
 *   supported parser.
 * - Positional metadata (`start` / `end` / `range` / `span` / `loc`) is
 *   optional so a node from any parser satisfies the model.
 * - Fields the analyzer reads defensively (with `?.`) are modeled as
 *   optional.
 *
 * The model is deliberately NOT a full ESTree spec — node kinds the analyzer
 * never branches on are omitted, and `Node` is the open union of every
 * modeled kind. The one parser-specific cast lives at the parse boundary in
 * `parse.ts`; everything downstream is typed.
 */

/** Parser-dependent positional metadata (all optional, parser-agnostic). */
export interface NodePosition {
  start?: number;
  end?: number;
  range?: [number, number];
  span?: [number, number];
  loc?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
}

export interface SourceLocation {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export interface Identifier extends NodePosition {
  type: "Identifier";
  name: string;
}

/**
 * A literal value node. `type` is the union of the literal-kind strings
 * emitted by the different parsers (`Literal` for Bun, `StringLiteral` /
 * `NumericLiteral` / `BooleanLiteral` / `NullLiteral` for oxc). All are
 * handled identically by the analyzer, so they share one interface.
 */
export interface Literal extends NodePosition {
  type: "Literal" | "StringLiteral" | "NumericLiteral" | "BooleanLiteral" | "NullLiteral";
  value: unknown;
  raw?: string;
}

export interface TemplateElement extends NodePosition {
  type: "TemplateElement";
  value?: { raw?: string; cooked?: string };
  tail?: boolean;
}

export interface TemplateLiteral extends NodePosition {
  type: "TemplateLiteral";
  quasis?: TemplateElement[];
  expressions?: Expression[];
}

export interface MemberExpression extends NodePosition {
  type: "MemberExpression";
  object: Expression;
  property: Expression;
  computed?: boolean;
  optional?: boolean;
}

export interface CallExpression extends NodePosition {
  type: "CallExpression";
  callee: Expression;
  arguments: Expression[];
  optional?: boolean;
}

export interface NewExpression extends NodePosition {
  type: "NewExpression";
  callee: Expression;
  arguments?: Expression[];
}

export interface UnaryExpression extends NodePosition {
  type: "UnaryExpression";
  operator: string;
  argument: Expression;
  prefix?: boolean;
}

export interface AwaitExpression extends NodePosition {
  type: "AwaitExpression";
  argument: Expression;
}

export interface ArrayExpression extends NodePosition {
  type: "ArrayExpression";
  elements?: Array<Expression | SpreadElement | null>;
}

export interface SpreadElement extends NodePosition {
  type: "SpreadElement";
  argument: Expression;
}

export interface ObjectExpression extends NodePosition {
  type: "ObjectExpression";
  properties?: Array<Property | SpreadElement>;
}

export interface Property extends NodePosition {
  type: "Property";
  key: Expression;
  value: Expression;
  computed?: boolean;
  kind?: "init" | "get" | "set";
  method?: boolean;
  shorthand?: boolean;
}

export interface ParenthesizedExpression extends NodePosition {
  type: "ParenthesizedExpression";
  expression: Expression;
}

/** TS wrapper nodes (`as`, `<T>`, `!`) are transparent for analysis. */
export interface TSExpressionWrapper extends NodePosition {
  type: "TSAsExpression" | "TSTypeAssertion" | "TSNonNullExpression";
  expression: Expression;
}

export interface ArrowFunctionExpression extends NodePosition {
  type: "ArrowFunctionExpression";
  params: Pattern[];
  body: BlockStatement | Expression;
  async?: boolean;
  generator?: boolean;
  expression?: boolean;
}

export interface FunctionExpression extends NodePosition {
  type: "FunctionExpression";
  id?: Identifier | null;
  params: Pattern[];
  body: BlockStatement;
  async?: boolean;
  generator?: boolean;
}

export interface FunctionDeclaration extends NodePosition {
  type: "FunctionDeclaration";
  id: Identifier | null;
  params: Pattern[];
  body: BlockStatement;
  async?: boolean;
  generator?: boolean;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

export interface ObjectPattern extends NodePosition {
  type: "ObjectPattern";
  properties?: Array<Property | RestElement>;
}

export interface RestElement extends NodePosition {
  type: "RestElement";
  argument: Pattern;
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export interface ExpressionStatement extends NodePosition {
  type: "ExpressionStatement";
  expression: Expression;
}

export interface BlockStatement extends NodePosition {
  type: "BlockStatement";
  body: Statement[];
}

export interface ReturnStatement extends NodePosition {
  type: "ReturnStatement";
  argument?: Expression | null;
}

export interface VariableDeclarator extends NodePosition {
  type: "VariableDeclarator";
  id: Pattern;
  init?: Expression | null;
}

export interface VariableDeclaration extends NodePosition {
  type: "VariableDeclaration";
  kind?: "var" | "let" | "const";
  declarations: VariableDeclarator[];
}

// ---------------------------------------------------------------------------
// Module declarations
// ---------------------------------------------------------------------------

export interface ExportDefaultDeclaration extends NodePosition {
  type: "ExportDefaultDeclaration";
  declaration: Expression | FunctionDeclaration | ClassDeclaration | null;
}

export interface ExportNamedDeclaration extends NodePosition {
  type: "ExportNamedDeclaration";
  declaration?: VariableDeclaration | FunctionDeclaration | ClassDeclaration | null;
  specifiers?: Array<ExportSpecifier | ExportNamespaceSpecifier>;
}

export interface ExportSpecifier extends NodePosition {
  type: "ExportSpecifier";
  local: Identifier;
  exported: Identifier;
}

export interface ExportNamespaceSpecifier extends NodePosition {
  type: "ExportNamespaceSpecifier";
  exported: Identifier;
}

export interface ExportAllDeclaration extends NodePosition {
  type: "ExportAllDeclaration";
  source?: Literal;
  exported?: Identifier | null;
}

export interface ClassDeclaration extends NodePosition {
  type: "ClassDeclaration";
  id?: Identifier | null;
}

export interface ImportDeclaration extends NodePosition {
  type: "ImportDeclaration";
  source?: Literal;
  specifiers?: ImportSpecifierNode[];
}

export interface ImportDefaultSpecifier extends NodePosition {
  type: "ImportDefaultSpecifier";
  local: Identifier;
}

export interface ImportNamespaceSpecifier extends NodePosition {
  type: "ImportNamespaceSpecifier";
  local: Identifier;
}

export interface ImportSpecifier extends NodePosition {
  type: "ImportSpecifier";
  local: Identifier;
  imported?: Identifier | Literal;
}

// ---------------------------------------------------------------------------
// Unions
// ---------------------------------------------------------------------------

export type Expression =
  | Identifier
  | Literal
  | TemplateLiteral
  | MemberExpression
  | CallExpression
  | NewExpression
  | UnaryExpression
  | AwaitExpression
  | ArrayExpression
  | ObjectExpression
  | ParenthesizedExpression
  | TSExpressionWrapper
  | ArrowFunctionExpression
  | FunctionExpression
  | SpreadElement;

export type Pattern = Identifier | ObjectPattern;

export type FunctionNode = ArrowFunctionExpression | FunctionExpression | FunctionDeclaration;

export type ImportSpecifierNode =
  | ImportDefaultSpecifier
  | ImportNamespaceSpecifier
  | ImportSpecifier;

export type Statement =
  | ExpressionStatement
  | BlockStatement
  | ReturnStatement
  | VariableDeclaration
  | FunctionDeclaration
  | ClassDeclaration
  | ExportDefaultDeclaration
  | ExportNamedDeclaration
  | ExportAllDeclaration
  | ImportDeclaration;

export type Node =
  | Expression
  | Statement
  | Program
  | VariableDeclarator
  | Property
  | ObjectPattern
  | RestElement
  | TemplateElement
  | ExportSpecifier
  | ExportNamespaceSpecifier;

export interface Program extends NodePosition {
  type: "Program";
  body: Statement[];
  sourceType?: "module" | "script";
}

/** True when `value` looks like a node (object with a string `type`). */
export function isNode(value: unknown): value is Node {
  return (
    !!value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string"
  );
}

/** True when a node is any literal kind. */
export function isLiteral(node: Node): node is Literal {
  return (
    node.type === "Literal" ||
    node.type === "StringLiteral" ||
    node.type === "NumericLiteral" ||
    node.type === "BooleanLiteral" ||
    node.type === "NullLiteral"
  );
}

/**
 * Read the static key of a property/member accessor. Accepts both an
 * identifier (`obj.foo` → `"foo"`) and a literal key used with computed
 * access (`obj["foo"]` → `"foo"`). Returns `undefined` for anything else
 * (e.g. computed expressions like `obj[key]`).
 */
export function propertyName(node: Expression | undefined): string | number | undefined {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name;
  if (isLiteral(node)) return node.value as string | number;
  return undefined;
}

/**
 * The binding name of a simple pattern, or `undefined` when the pattern is
 * not a plain identifier (destructuring). Used where the analyzer only cares
 * about `const foo = …` / `function foo(){}` bindings.
 */
export function bindingName(node: Pattern | undefined | null): string | undefined {
  if (!node) return undefined;
  return node.type === "Identifier" ? node.name : undefined;
}
