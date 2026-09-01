/**
 * @fileoverview Route-file index — lazy AOT-manifest lookup mapping
 * `"METHOD /route"` to the original route module file. Extracted from the
 * plugin so request-detail handlers can resolve "where in my code" pointers.
 */

import { buildRouteFileIndex } from "../kt";

export interface RouteFileIndex {
  /** Look up the source file for a route key; null when unknown. */
  lookup: (key: string) => Promise<string | null>;
}

/** Build a lazily-initialized index for the given manifest paths. */
export const createRouteFileIndex = (manifestPaths: string[]): RouteFileIndex => {
  let index: Promise<ReadonlyMap<string, string>> | null = null;

  const ensure = (): Promise<ReadonlyMap<string, string>> => {
    if (index === null) index = buildRouteFileIndex(manifestPaths);
    return index;
  };

  return {
    lookup: async (key): Promise<string | null> => {
      if (manifestPaths.length === 0) return null;
      try {
        const map = await ensure();
        if (!map || map.size === 0) return null;
        return map.get(key) ?? null;
      } catch {
        return null;
      }
    },
  };
};
