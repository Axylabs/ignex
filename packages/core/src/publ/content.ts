/**
 * @fileoverview Public sub-barrel: content (i18n + template) re-exported from
 * the `@ignex/core` entry (split from the barrel `src/index.ts` by section
 * banner — move-only; `export` statements verbatim).
 */

// ── content ─────────────────────────────────────────────────────
export type { Catalog, Catalogs, I18n, I18nOptions, LoadCatalogDirOptions } from "../content/i18n";
export {
  createI18n,
  createI18nFromDir,
  formatCurrency,
  formatDate,
  formatNumber,
  interpolate,
  LOCALE_KEY,
  loadCatalogDir,
  negotiateLocale,
  pluralCategory,
  withI18n,
} from "../content/i18n";
export type { TemplateContext, TemplateFn, TemplateRegistry } from "../content/template";
export {
  createTemplate,
  createTemplateDir,
  createTemplateRegistry,
  renderTemplate,
  withLayout,
} from "../content/template";
