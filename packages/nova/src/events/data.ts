/**
 * Per-connection app data store — the "what to store for each client" half of
 * the client record. A tiny Map-backed key/value bag with JSON export, created
 * on attach and discarded on detach (no leak across reconnects).
 */
import type { ClientData } from "./types";

export function createClientData(): ClientData {
  const map = new Map<string, unknown>();
  return {
    get(key) {
      return map.get(key);
    },
    set(key, value) {
      map.set(key, value);
    },
    has(key) {
      return map.has(key);
    },
    delete(key) {
      return map.delete(key);
    },
    clear() {
      map.clear();
    },
    keys() {
      return [...map.keys()];
    },
    entries() {
      return [...map.entries()];
    },
    toJSON() {
      const out: Record<string, unknown> = {};
      for (const [k, v] of map) out[k] = v;
      return out;
    },
  };
}
