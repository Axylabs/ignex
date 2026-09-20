/**
 * @fileoverview Test-only registry fixture. `views/registry.tsx` is a Solid
 * `.tsx` module that cannot be imported under the repo's `jsx: "preserve"`
 * vitest config, so this reads it as source and extracts the real `VIEWS`
 * entries. Deriving the unit-test stubs from here keeps them from silently
 * drifting from the registry they stand in for.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = readFileSync(
  fileURLToPath(new URL("../../src/debug/ui/views/registry.tsx", import.meta.url)),
  "utf8",
);

/** One registry entry, as parsed from source. */
export interface RegistryView {
  /** Route id (hash segment). */
  id: string;
  /** Nav label. */
  label: string;
}

/**
 * The `VIEWS` array's `{ id, label }` pairs, in source order. Throws if the
 * array cannot be found or an entry cannot be parsed, so a registry rewrite
 * fails loudly rather than yielding an empty fixture.
 */
export const registryViews = (): RegistryView[] => {
  const body = SOURCE.match(/export const VIEWS: ViewDef\[\] = \[([\s\S]*?)\n\];/)?.[1];
  if (body === undefined) throw new Error("VIEWS array not found in registry.tsx");
  const views = [...body.matchAll(/\{\s*id:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g)].map((match) => ({
    id: match[1] as string,
    label: match[2] as string,
  }));
  if (views.length === 0) throw new Error("no VIEWS entries parsed from registry.tsx");
  return views;
};
