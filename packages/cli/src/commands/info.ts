/**
 * @fileoverview `ignex info` — machine-readable app/compiler info.
 *
 * Prints JSON describing the resolved project root, runtime versions, native
 * acceleration backend, and merged compiler config. The project root follows
 * the standard resolution chain (`--root` → walk-up discovery → cwd).
 */

import { defineCommand } from "citty";
import { loadConfig } from "../utils/config.js";
import { resolveProjectRoot } from "../utils/discover-root.js";
import { nativeStatus } from "../utils/native.js";
import { runDef } from "../utils/run-def.js";
import { metaFor } from "./registry.js";

/** Print app/compiler info as JSON. */
export const infoCmd = defineCommand({
  meta: metaFor("info"),
  args: {
    root: { type: "string", valueHint: "dir", description: "Project root" },
  },
  async run({ args }) {
    const root = await resolveProjectRoot(args.root);
    const config = await loadConfig(root);
    const native = await nativeStatus();

    console.log(
      JSON.stringify(
        {
          cwd: root,
          runtime: process.versions.bun ? "bun" : "node",
          node: process.version,
          bun: process.versions.bun ?? null,
          native: {
            available: native.available,
            backend: native.backend,
          },
          config,
        },
        null,
        2,
      ),
    );
  },
});

export default infoCmd;

/** Back-compat entry: raw argv → parsed via citty. */
export const runInfo = (args: string[]): Promise<void> => runDef(infoCmd, args);
