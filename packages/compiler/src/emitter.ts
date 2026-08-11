/**
 * @fileoverview Indentation-aware code emitter for generated server output.
 *
 * Replaces raw `string[]` + template-literal concatenation with a small,
 * deterministic, indentation-aware writer — the same idea behind Svelte's
 * printer (esrap). It also tracks which runtime helpers are actually used so
 * codegen can emit only the boilerplate that is referenced (dead-code
 * elimination of generated helpers).
 */

export class Emitter {
  private readonly out: string[] = [];
  private depth = 0;
  private readonly indentUnit = "  ";
  private readonly helpers = new Set<string>();
  private readonly core = new Set<string>();

  /** Record that a generated runtime helper is referenced by emitted code. */
  markUsed(name: string): void {
    this.helpers.add(name);
  }

  isUsed(name: string): boolean {
    return this.helpers.has(name);
  }

  /** Record that a `@ignus/core` symbol is referenced by emitted code. */
  markCore(name: string): void {
    this.core.add(name);
  }

  isCoreUsed(name: string): boolean {
    return this.core.has(name);
  }

  /** Emit a single line at the current indentation. */
  line(text = ""): this {
    this.out.push(`${this.indentUnit.repeat(this.depth)}${text}`);
    return this;
  }

  get length(): number {
    return this.out.length;
  }

  toString(): string {
    return this.out.join("\n");
  }
}
