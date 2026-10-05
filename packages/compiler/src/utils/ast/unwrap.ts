/**
 * @fileoverview TypeScript expression unwrapping — strip `as` / `!` / `<T>` /
 * parentheses to reach the underlying expression.
 *
 * Several analysis phases walk the same wrapper chain; this is the single
 * implementation so their behaviour cannot drift.
 */

/** Minimal shape the unwrapper needs — any oxc AST node. */
interface Wrappable {
  type: string;
  expression?: unknown;
}

/**
 * Strip TypeScript expression wrappers (`as`, `!`, `<T>`, parentheses) and
 * return the underlying expression. Returns `undefined` for a nullish input.
 *
 * The input type is preserved so callers keep their concrete node type.
 */
export const unwrapExpression = <N extends Wrappable>(
  node: N | null | undefined,
): N | undefined => {
  let current: N | undefined = node ?? undefined;
  while (
    current &&
    (current.type === "TSAsExpression" ||
      current.type === "TSTypeAssertion" ||
      current.type === "TSNonNullExpression" ||
      current.type === "ParenthesizedExpression")
  ) {
    current = (current as { expression?: N }).expression;
  }
  return current;
};
