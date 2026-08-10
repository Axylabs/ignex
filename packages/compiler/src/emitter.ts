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

  /** Record that a `@flux/core` symbol is referenced by emitted code. */
  markCore(name: string): void {
    this.core.add(name);
  }

  isCoreUsed(name: string): boolean {
    return this.core.has(name);
  }

  indent(): void {
    this.depth++;
  }

  dedent(): void {
    if (this.depth > 0) this.depth--;
  }

  /** Emit a single line at the current indentation. */
  line(text = ""): this {
    this.out.push(`${this.indentUnit.repeat(this.depth)}${text}`);
    return this;
  }

  /** Emit a blank line. */
  blank(): this {
    this.out.push("");
    return this;
  }

  /** Emit a `//` comment line. */
  comment(text: string): this {
    this.line(`// ${text}`);
    return this;
  }

  /** Emit a block: `open {`, indented body, `close`. */
  block(open: string, body: () => void, close = "}"): this {
    this.line(`${open} {`);
    this.indent();
    body();
    this.dedent();
    this.line(close);
    return this;
  }

  /** Emit a multi-line raw template without re-indentation. */
  raw(text: string): this {
    this.out.push(text);
    return this;
  }

  get length(): number {
    return this.out.length;
  }

  toString(): string {
    return this.out.join("\n");
  }
}
