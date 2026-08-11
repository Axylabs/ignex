/**
 * Template rendering — minijinja (native) with a small pure-TS fallback.
 * Provides single templates, registries, directory loading and layout
 * composition helpers.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createTemplate as createNativeTemplate,
  renderTemplate as renderNative,
} from "@ignus/native";

export type TemplateContext = Record<string, unknown>;
export type TemplateFn = (data: TemplateContext) => string;

/** Compile a template source into a reusable render function. */
export const createTemplate = (source: string): TemplateFn => createNativeTemplate(source);

/** Render a template source once with the given context. */
export const renderTemplate = (source: string, data: TemplateContext): string =>
  renderNative(source, data);

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
 */
export const withLayout =
  (layout: (content: string, data: TemplateContext) => string) =>
  (page: TemplateFn): TemplateFn =>
  (data) =>
    layout(page(data), data);
