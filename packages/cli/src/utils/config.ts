import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { exists, readTextFile } from "./fs.js";
import { warn } from "./logger.js";

const CONFIG_FILES = [
  "flux.config.ts",
  "flux.config.mts",
  "flux.config.mjs",
  "flux.config.js",
  "flux.config.json",
];

export async function loadConfig(root: string): Promise<Record<string, unknown>> {
  for (const file of CONFIG_FILES) {
    const configPath = join(root, file);
    if (!(await exists(configPath))) continue;

    if (file.endsWith(".json")) {
      try {
        return JSON.parse(await readTextFile(configPath)) as Record<string, unknown>;
      } catch (err) {
        warn(`Failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
        return {};
      }
    }

    try {
      const url = `${pathToFileURL(configPath).href}?t=${Date.now()}`;
      const mod = (await import(url)) as {
        default?: unknown;
      };

      const value = mod.default ?? mod;

      if (typeof value === "function") {
        return (await (value as () => Promise<Record<string, unknown>>)()) ?? {};
      }

      return (value ?? {}) as Record<string, unknown>;
    } catch (err) {
      if (file.endsWith(".ts") || file.endsWith(".mts")) {
        warn(`Could not import ${file}. Use flux.config.mjs with Node, or run the CLI with Bun.`);
      } else {
        warn(`Failed to load ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return {};
}
