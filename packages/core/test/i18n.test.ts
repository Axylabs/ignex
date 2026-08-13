/**
 * i18n JSON catalog directory loading + withI18n alias tests.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createI18nFromDir, loadCatalogDir, negotiateLocale, withI18n } from "../src/content/i18n";

const tmp = () => mkdtempSync(join(tmpdir(), "ignex-i18n-"));

const makeLayout = (dir: string) => {
  // en.json (flat) + en/errors.json (namespaced) + es.json
  writeFileSync(join(dir, "en.json"), JSON.stringify({ hi: "Hello {name}" }));
  mkdirSync(join(dir, "en"), { recursive: true });
  writeFileSync(join(dir, "en", "errors.json"), JSON.stringify({ notFound: "Not found" }));
  writeFileSync(join(dir, "es.json"), JSON.stringify({ hi: "Hola {name}" }));
};

describe("loadCatalogDir", () => {
  it("loads flat and namespaced catalogs from a directory", () => {
    const dir = tmp();
    makeLayout(dir);

    const catalogs = loadCatalogDir(dir);
    expect(catalogs.en?.hi).toBe("Hello {name}");
    expect(catalogs.en?.["errors.notFound"]).toBe("Not found");
    expect(catalogs.es?.hi).toBe("Hola {name}");
  });

  it("merges multiple namespaced files under one locale", () => {
    const dir = tmp();
    mkdirSync(join(dir, "en"), { recursive: true });
    writeFileSync(join(dir, "en", "ui.json"), JSON.stringify({ ok: "OK" }));
    writeFileSync(join(dir, "en", "errors.json"), JSON.stringify({ bad: "Bad" }));

    const catalogs = loadCatalogDir(dir);
    expect(catalogs.en?.["ui.ok"]).toBe("OK");
    expect(catalogs.en?.["errors.bad"]).toBe("Bad");
  });

  it("supports nested namespace subpaths", () => {
    const dir = tmp();
    mkdirSync(join(dir, "fr", "nested"), { recursive: true });
    writeFileSync(join(dir, "fr", "nested", "ui.json"), JSON.stringify({ save: "Enregistrer" }));

    const catalogs = loadCatalogDir(dir);
    expect(catalogs.fr?.["nested.ui.save"]).toBe("Enregistrer");
  });

  it("skips unreadable/invalid files and reports via onError", () => {
    const dir = tmp();
    writeFileSync(join(dir, "en.json"), "{ not json");
    const errors: string[] = [];
    const catalogs = loadCatalogDir(dir, { onError: (locale) => errors.push(locale) });
    expect(catalogs.en).toBeUndefined();
    expect(errors).toContain("en");
  });

  it("is consumed by createI18nFromDir", () => {
    const dir = tmp();
    makeLayout(dir);
    const i18n = createI18nFromDir(dir);
    expect(i18n.t("hi", { name: "World" }, "es")).toBe("Hola World");
    expect(i18n.t("errors.notFound", {}, "en")).toBe("Not found");
  });
});

describe("withI18n", () => {
  it("exposes a middleware hook from an I18n instance", async () => {
    const dir = tmp();
    makeLayout(dir);
    const i18n = createI18nFromDir(dir);
    const hook = withI18n(i18n, { stateKey: "locale" });

    const state: Record<string, unknown> = {};
    const ctx = {
      headers: new Headers({ "accept-language": "es" }),
      getState: (key: symbol | string) => state[key as string],
      setState: (key: symbol | string, value: unknown) => {
        state[key as string] = value;
      },
    } as never;

    const result = await hook(ctx as never);
    expect(result).toBeDefined();
    expect(state.locale).toBe("es");
  });
});

describe("negotiateLocale (precompiled matcher)", () => {
  const supported = ["en", "es", "fr"] as const;

  it("returns the default when no header is present", () => {
    expect(negotiateLocale(null, supported, { defaultLocale: "en" })).toBe("en");
    expect(negotiateLocale("", supported, { defaultLocale: "en" })).toBe("en");
  });

  it("matches exact tags in q-value order", () => {
    expect(negotiateLocale("es", supported)).toBe("es");
    expect(negotiateLocale("fr;q=0.8, es;q=0.9", supported)).toBe("es");
    expect(negotiateLocale("fr;q=0.9, es;q=0.8", supported)).toBe("fr");
  });

  it("matches a region-suffixed request to its base supported tag", () => {
    expect(negotiateLocale("fr-FR", supported)).toBe("fr");
    expect(negotiateLocale("en-US, fr", supported)).toBe("en");
  });

  it("falls back when nothing matches", () => {
    expect(negotiateLocale("xx-YY", supported, { defaultLocale: "en" })).toBe("en");
    expect(negotiateLocale("de", ["en"], { defaultLocale: "en" })).toBe("en");
    expect(negotiateLocale("de", [])).toBe("en");
  });

  it("ignores q=0 preferences and preserves the empty-tag quirk", () => {
    expect(negotiateLocale("es;q=0, fr", supported)).toBe("fr");
    // A leading comma yields an empty tag — indexOf("") semantics return the
    // first supported locale (behavior preserved from the original matcher).
    expect(negotiateLocale(", fr", supported)).toBe("en");
  });
});
