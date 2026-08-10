/**
 * Internationalization — message catalogs, locale negotiation and a request
 * hook that attaches `ctx.t` and `ctx.state.locale`.
 */
import type { FluxContext } from "./context";
import { continueHook, type HookFn } from "./hooks";

export type Catalog = Record<string, string>;
export type Catalogs = Record<string, Catalog>;

export interface I18nOptions {
  /** Locale used when no match is found (default `en`). */
  fallbackLocale?: string;
  /** Locale used when no `Accept-Language` header is present. */
  defaultLocale?: string;
}

export interface I18n {
  /** Translate a key with `{name}` interpolation. */
  t(key: string, params?: Record<string, unknown>, locale?: string): string;
  /** Resolve the active locale for a context. */
  locale(ctx: FluxContext): string;
  /** Request hook: negotiate locale and attach `ctx.t` + locale state. */
  middleware(options?: { stateKey?: string }): HookFn;
}

/** Locale state key on `ctx.state`. */
export const LOCALE_KEY = Symbol.for("flux.locale");

interface NegotiateOptions {
  defaultLocale?: string;
}

/**
 * Pick the best supported locale from an `Accept-Language` header
 * (language-range matching with `q` weighting and base-language fallback).
 */
export const negotiateLocale = (
  acceptLanguage: string | null,
  supported: readonly string[],
  options: NegotiateOptions = {},
): string => {
  if (!acceptLanguage || supported.length === 0) {
    return options.defaultLocale ?? supported[0] ?? "en";
  }

  const prefs = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      let q = 1;
      for (const param of params) {
        const eq = param.indexOf("=");
        if (eq >= 0 && param.slice(0, eq).trim() === "q") {
          const parsed = Number(param.slice(eq + 1).trim());
          if (!Number.isNaN(parsed)) q = parsed;
        }
      }
      return { tag: tag.trim().toLowerCase(), q };
    })
    .sort((a, b) => b.q - a.q);

  const lower = supported.map((locale) => locale.toLowerCase());

  for (const pref of prefs) {
    if (pref.q <= 0) continue;
    const exact = lower.indexOf(pref.tag);
    if (exact >= 0) return supported[exact];
    const base = pref.tag.split("-")[0];
    const baseIndex = lower.indexOf(base);
    if (baseIndex >= 0) return supported[baseIndex];
  }

  return options.defaultLocale ?? supported[0] ?? "en";
};

/** Interpolate `{name}` placeholders from a params object. */
export const interpolate = (
  template: string,
  params: Record<string, unknown> | undefined,
): string =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params?.[key];
    return value === undefined || value === null ? match : String(value);
  });

export const createI18n = (catalogs: Catalogs, options: I18nOptions = {}): I18n => {
  const fallbackLocale = options.fallbackLocale ?? "en";
  const defaultLocale = options.defaultLocale ?? fallbackLocale;

  const lookup = (key: string, locale?: string): string =>
    (locale && catalogs[locale]?.[key]) ?? catalogs[fallbackLocale]?.[key] ?? key;

  const i18n: I18n = {
    t(key, params, locale) {
      return interpolate(lookup(key, locale), params);
    },

    locale(ctx) {
      return ctx.getState<string>(LOCALE_KEY) ?? defaultLocale;
    },

    middleware(middlewareOptions = {}) {
      const stateKey = middlewareOptions.stateKey ?? "locale";
      const translate = i18n.t;

      return async (ctx) => {
        const locale = negotiateLocale(ctx.headers.get("accept-language"), Object.keys(catalogs), {
          defaultLocale,
        });

        ctx.setState(LOCALE_KEY, locale);
        ctx.setState(stateKey, locale);

        (ctx as FluxContext & { t: I18n["t"] }).t = (key, params) => translate(key, params, locale);

        return continueHook(ctx);
      };
    },
  };

  return i18n;
};
