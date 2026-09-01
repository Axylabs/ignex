/**
 * Native surface-drift gate: the hand-maintained castrum type stub
 * (`packages/native/src/vendor/castrum.d.ts`) is the COMPILE-TIME contract for
 * every `@ignex/native` import (root tsconfig maps bare `"castrum"` to it), so
 * a renamed/removed runtime export in the addon would still typecheck while
 * breaking at runtime. This compares every function/class declared in the
 * stub against the REAL loaded module surface (NAPI `.node` binary + TS entry)
 * and fails loudly on drift.
 *
 * Skips cleanly (exit 0) when no addon/module is resolvable — fallback-only
 * environments have nothing to compare against; run it in CI's native-parity
 * job where the real addon is built.
 *
 * Usage: `bun scripts/check-native-surface.ts`
 *   IGNEX_NATIVE_PATH=/path/to/castrum.*.node bun scripts/check-native-surface.ts
 */
import { readFileSync } from "node:fs";
import { getNative, loadCastrumModule } from "../packages/native/src/loader.ts";

/**
 * Extract runtime-relevant exported names (functions/classes) from the stub.
 * Type-only exports (interfaces/types) are intentionally skipped — they have
 * no runtime presence to compare against.
 */
const stubSurface = (): string[] => {
  const src = readFileSync("packages/native/src/vendor/castrum.d.ts", "utf8");
  const names = new Set<string>();
  for (const m of src.matchAll(/^export declare (?:function|class) ([A-Za-z0-9_]+)/gm)) {
    if (m[1]) names.add(m[1]);
  }
  return [...names];
};

const main = async (): Promise<void> => {
  const native = getNative();
  // Secondary source only: a few stub symbols (e.g. `createPipeline`) live in
  // castrum's TS integration layer, not on the `.node` binary. The NAPI addon
  // remains the REQUIRED reference — the TS entry alone does not carry the
  // raw op surface, so its absence means "nothing to compare", never failure.
  const tsModule = await loadCastrumModule();

  if (!native) {
    console.log(
      "check-native-surface: no castrum addon resolvable — skipping " +
        "(run in an environment with the real addon, e.g. CI native-parity).",
    );
    process.exit(0);
  }

  const has = (name: string): boolean =>
    (native != null && typeof (native as Record<string, unknown>)[name] === "function") ||
    (tsModule != null && typeof tsModule[name] === "function");

  const missing = stubSurface().filter((name) => !has(name));

  if (missing.length > 0) {
    console.error("check-native-surface FAILED — stub declares symbols the real module lacks:");
    for (const name of missing) console.error(`  - ${name}`);
    console.error(
      "\nThe vendor/castrum.d.ts stub is the compile-time contract for @ignex/native; " +
        "drift means the installed addon no longer matches what ignex compiles against. " +
        "Update the stub / pin the castrum version so they agree.",
    );
    process.exit(1);
  }

  const source = `NAPI addon${tsModule ? " + TS entry" : ""}`;
  console.log(
    `check-native-surface: all ${stubSurface().length} stub symbols present on the real module (${source}).`,
  );
};

main();
