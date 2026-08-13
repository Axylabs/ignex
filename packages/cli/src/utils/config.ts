import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { exists, readTextFile } from "./fs.js";
import { warn } from "./logger.js";

/** All config filenames `loadConfig` reads, in priority order. */
export const CONFIG_FILES = [
  "ignex.config.ts",
  "ignex.config.mts",
  "ignex.config.mjs",
  "ignex.config.js",
  "ignex.config.json",
] as const;

/** Parse a `ignex.config.json` file; warns + returns `{}` on failure. */
async function loadJsonConfig(configPath: string, file: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readTextFile(configPath)) as Record<string, unknown>;
  } catch (err) {
    warn(`Failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

/** Import a `ignex.config.{ts,mts,mjs,js}` module; warns + returns `null` on failure. */
async function loadModuleConfig(
  configPath: string,
  file: string,
): Promise<Record<string, unknown> | null> {
  try {
    const url = `${pathToFileURL(configPath).href}?t=${Date.now()}`;
    const mod = (await import(url)) as {
      default?: unknown;
    };

    const value = mod.default ?? mod;

    if (typeof value === "function") {
      return (await (value as () => Promise<Record<string, unknown>>)()) ?? {};
    }

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      warn(`${file} must export a plain config object.`);
      return {};
    }

    return value as Record<string, unknown>;
  } catch (err) {
    if (file.endsWith(".ts") || file.endsWith(".mts")) {
      warn(`Could not import ${file}. Use ignex.config.mjs with Node, or run the CLI with Bun.`);
    } else {
      warn(`Failed to load ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
}

export async function loadConfig(root: string): Promise<Record<string, unknown>> {
  for (const file of CONFIG_FILES) {
    const configPath = join(root, file);
    if (!(await exists(configPath))) continue;
    if (file.endsWith(".json")) return loadJsonConfig(configPath, file);
    const loaded = await loadModuleConfig(configPath, file);
    if (loaded) return loaded;
  }

  return {};
}
