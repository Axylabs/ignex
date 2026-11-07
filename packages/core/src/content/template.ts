/**
 * Template rendering — minijinja (native) with a small pure-TS fallback.
 * Provides single templates, registries, directory loading and layout
 * composition helpers.
 *
 * Security contract: `{{ }}` interpolation is HTML auto-escaped by DEFAULT in
 * both engines (identical minijinja `AutoEscape::Html` table); the `| safe`
 * filter opts a value out and `{ autoescape: false }` disables the gate.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createTemplate as createNativeTemplate,
  renderTemplate as renderNative,
  type TemplateRenderOptions,
} from "@ignex/native";

/** Variables passed to a template render. */
export type TemplateContext = Record<string, unknown>;
/** A compiled template: renders a context to a string. */
export type TemplateFn = (data: TemplateContext) => string;

/**
 * Compile a template source into a reusable render function.
 * `{{ }}` interpolation is HTML auto-escaped by default (`| safe` opts a
 * value out); pass `{ autoescape: false }` to render raw.
 */
export const createTemplate = (source: string, options?: TemplateRenderOptions): TemplateFn =>
  createNativeTemplate(source, options);

/** Render a template source once with the given context (auto-escaped). */
export const renderTemplate = (
  source: string,
  data: TemplateContext,
  options?: TemplateRenderOptions,
): string => renderNative(source, data, options);

/**
 * A named collection of compiled templates.
 *
 * `render` throws when the template name is unknown.
 */
export interface TemplateRegistry {
  render(name: string, data: TemplateContext): string;
  has(name: string): boolean;
}

/** Create a registry from an in-memory `{ name: source }` map. */
export const createTemplateRegistry = (templates: Record<string, string>): TemplateRegistry => {
  const compiled = new Map(
    Object.entries(templates).map(([name, source]) => [name, createTemplate(source)]),
  );

  return {
    has: (name) => compiled.has(name),
    render: (name, data) => {
      const renderer = compiled.get(name);
      if (!renderer) throw new Error(`Template not found: ${name}`);
      return renderer(data);
    },
  };
};

/** Options for {@link createTemplateDir}. */
export interface TemplateDirOptions {
  /** File extension to scan (default `.html`). */
  ext?: string;
}

/** Load every template in a directory into a registry (name = basename). */
export const createTemplateDir = async (
  dir: string,
  options: TemplateDirOptions = {},
): Promise<TemplateRegistry> => {
  const ext = options.ext ?? ".html";
  const files = await readdir(dir);
  const templates: Record<string, string> = {};

  for (const file of files) {
    if (!file.endsWith(ext)) continue;
    const name = file.slice(0, -ext.length);
    templates[name] = await readFile(join(dir, file), "utf8");
  }

  return createTemplateRegistry(templates);
};

/**
 * Compose a layout around a page renderer:
 * `withLayout(layout)(page)` → `(data) => layout(page(data), data)`.
 *
 * The composed page markup is framework-generated HTML — the layout glue must
 * opt it out of auto-escaping explicitly (`{{ content | safe }}`); unmarked
 * context values are escaped by default.
 */
export const withLayout =
  (layout: (content: string, data: TemplateContext) => string) =>
  (page: TemplateFn): TemplateFn =>
  (data) =>
    layout(page(data), data);
