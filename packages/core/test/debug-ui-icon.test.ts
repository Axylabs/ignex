/**
 * @fileoverview Icon-set guard — proves every `IconName` in the inline-SVG set
 * resolves to non-empty path data. TypeScript already proves `PATHS` is
 * exhaustive, so this only catches the runtime hazard it cannot: empty-string
 * placeholders and orphan keys. The component is read as source (like
 * `debug-ui-tokens.test.ts` reads the stylesheet) because the Solid `.tsx`
 * cannot be imported under the repo's `jsx: "preserve"` + node test config.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  fileURLToPath(new URL("../src/debug/ui/components/icon.tsx", import.meta.url)),
  "utf8",
);

/** Quoted members of the exported `IconName` union. */
const names = (): string[] => {
  const body = SOURCE.match(/export type IconName =([\s\S]*?);/)?.[1];
  if (body === undefined) throw new Error("IconName union not found");
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
};

/** `name: "path"` entries of the private `PATHS` record. */
const paths = (): Map<string, string> => {
  const body = SOURCE.match(/const PATHS: Record<IconName, string> = \{([\s\S]*?)\n\};/)?.[1];
  if (body === undefined) throw new Error("PATHS record not found");
  const out = new Map<string, string>();
  for (const m of body.matchAll(/"?([\w-]+)"?:\s*"([^"]*)"/g)) {
    out.set(m[1] as string, m[2] as string);
  }
  return out;
};

describe("debugbar icon set", () => {
  it("declares a non-empty union", () => {
    expect(names().length).toBeGreaterThan(30);
  });

  it("maps every IconName to non-empty path data", () => {
    const data = paths();
    for (const name of names()) {
      const d = data.get(name);
      expect(d, `missing icon: ${name}`).toBeDefined();
      expect(d, `empty icon: ${name}`).not.toBe("");
    }
  });

  it("has no path data for a name outside the union", () => {
    const declared = new Set(names());
    for (const key of paths().keys()) {
      expect(declared.has(key), `orphan path: ${key}`).toBe(true);
    }
  });
});
