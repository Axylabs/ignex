/**
 * @fileoverview Lazy optional nova code generator loading for the realtime SDK.
 */

/** Structural contract of `generateBindings`' return value. */
interface NovaGenerated {
  files: Record<string, string>;
}

/** Structural contract of the dynamically imported `@ignex/nova/generate`. */
interface NovaGenerateModule {
  generateBindings(
    schema: { schemas?: unknown; events: unknown; controlEvents?: unknown },
    options: { rust: false; ffiMode: "optional"; subjectPrefix: string; force: true },
  ): NovaGenerated;
}

/** Load nova codegen lazily and explain missing peer/flatc prerequisites. */
export const loadNovaGenerate = async (): Promise<NovaGenerateModule> => {
  const specifier: string = "@ignex/nova/generate";
  try {
    const mod = (await import(specifier)) as Partial<NovaGenerateModule>;
    if (mod.generateBindings === undefined) {
      throw new Error("module has no generateBindings export");
    }
    return mod as NovaGenerateModule;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The realtime SDK platform requires the optional peer "@ignex/nova" — install it with ` +
        `\`bun add @ignex/nova\`. Codegen additionally needs the FlatBuffers compiler (\`flatc\`) on ` +
        `PATH (brew install flatbuffers / apt install flatbuffers-compiler). Import failed: ${reason}`,
    );
  }
};
