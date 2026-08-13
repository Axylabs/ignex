/**
 * i18n depth tests: CLDR pluralization (via Intl.PluralRules), plural-aware
 * `t`, and Intl number/currency/date formatting.
 */
import { describe, expect, it } from "vitest";
import {
  createI18n,
  formatCurrency,
  formatDate,
  formatNumber,
  pluralCategory,
} from "../src/index.js";

const en = createI18n({
  en: {
    "items.one": "1 item",
    "items.other": "{count} items",
    items: "items",
    hello: "Hello {name}!",
  },
  ru: {
    "items.one": "{count} элемент",
    "items.few": "{count} элемента",
    "items.many": "{count} элементов",
  },
  ar: {
    "items.zero": "لا عناصر",
    "items.one": "عنصر واحد",
    "items.two": "عنصران",
    "items.few": "{count} عناصر",
    "items.many": "{count} عنصرًا",
  },
});

describe("i18n pluralization", () => {
  it("resolves en one/other from a numeric count", () => {
    expect(en.t("items", { count: 1 })).toBe("1 item");
    expect(en.t("items", { count: 2 })).toBe("2 items");
    expect(en.t("items", { count: 0 })).toBe("0 items"); // en has no zero → other
  });

  it("falls back to the plain key when no plural forms exist", () => {
    expect(en.t("hello", { count: 3 })).toBe("Hello {name}!");
    expect(en.t("hello", { name: "ada" })).toBe("Hello ada!");
  });

  it("uses locale-specific CLDR categories (ru one/few/many)", () => {
    expect(pluralCategory("ru", 1)).toBe("one");
    expect(pluralCategory("ru", 2)).toBe("few");
    expect(pluralCategory("ru", 5)).toBe("many");

    expect(en.t("items", { count: 1 }, "ru")).toBe("1 элемент");
    expect(en.t("items", { count: 2 }, "ru")).toBe("2 элемента");
    expect(en.t("items", { count: 5 }, "ru")).toBe("5 элементов");
  });

  it("supports ar zero/one/two", () => {
    expect(pluralCategory("ar", 0)).toBe("zero");
    expect(pluralCategory("ar", 1)).toBe("one");
    expect(pluralCategory("ar", 2)).toBe("two");

    expect(en.t("items", { count: 0 }, "ar")).toBe("لا عناصر");
    expect(en.t("items", { count: 2 }, "ar")).toBe("عنصران");
  });

  it("pluralize resolves the right form explicitly", () => {
    expect(en.pluralize("items", 1)).toBe("1 item");
    expect(en.pluralize("items", 5)).toBe("5 items");
    expect(en.pluralize("items", 2, "ru")).toBe("2 элемента");
  });
});

describe("i18n Intl formatting", () => {
  it("formats numbers per locale", () => {
    expect(formatNumber(1234.5, "en-US")).toBe("1,234.5");
    expect(formatNumber(1234.5, "de-DE")).toBe("1.234,5");
  });

  it("formats currency per locale", () => {
    expect(formatCurrency(10, "USD", "en-US")).toBe("$10.00");
    expect(formatCurrency(10, "EUR", "de-DE")).toContain("10,00");
  });

  it("formats dates", () => {
    const d = new Date("2026-01-15T12:00:00Z");
    expect(formatDate(d, "en-US", { year: "numeric", month: "long" })).toContain("2026");
    expect(en.d(d, { year: "numeric", month: "short" }, "en-US")).toContain("Jan");
  });

  it("i18n methods default to the instance defaultLocale", () => {
    const de = createI18n({ de: {} }, { defaultLocale: "de-DE" });
    expect(de.n(1234.5)).toBe("1.234,5");
    expect(de.currency(10, "EUR")).toContain("10,00");
  });
});
