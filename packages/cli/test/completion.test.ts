import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadCompletableCommands, runComplete } from "../src/commands/complete.js";
import { runCompletions } from "../src/commands/completions.js";
import { FEATURE_NAMES } from "../src/types.js";
import type { CompletableCommand, flagsFromArgs } from "../src/utils/completion.js";
import {
  COMPLETION_SHELLS,
  complete,
  HTTP_METHODS,
  tokenizeLine,
} from "../src/utils/completion.js";

/** The live completable command table (registry rows + typed citty args). */
const table: CompletableCommand[] = await loadCompletableCommands();

const flagsFor = (name: string): ReturnType<typeof flagsFromArgs> =>
  table.find((c) => c.name === name)?.flags ?? [];

describe("tokenizeLine", () => {
  it("splits completed tokens from the in-progress token", () => {
    expect(tokenizeLine("ignex cre", 9)).toEqual({ before: ["ignex"], current: "cre" });
    expect(tokenizeLine("ignex create --r", 16)).toEqual({
      before: ["ignex", "create"],
      current: "--r",
    });
  });

  it("treats a trailing space as a fresh token position", () => {
    expect(tokenizeLine("ignex create ", 13)).toEqual({
      before: ["ignex", "create"],
      current: "",
    });
  });

  it("keeps quoted spaces attached to the current token", () => {
    expect(tokenizeLine("ignex route 'my file'", 21)).toEqual({
      before: ["ignex", "route"],
      current: "my file",
    });
  });
});

describe("complete", () => {
  it("completes command names and aliases", () => {
    expect(complete(table, "ignex ", 6)).toContain("create");
    expect(complete(table, "ignex ", 6)).toContain("completions");
    expect(complete(table, "ignex cre", 9)).toEqual(["create"]);
    expect(complete(table, "ignex r", 7)).toContain("route");
    expect(complete(table, "ignex wa", 8)).toEqual(["watch"]);
  });

  it("does not surface hidden backend commands", () => {
    expect(complete(table, "ignex _", 7)).not.toContain("_complete");
  });

  it("completes flags for a command", () => {
    const result = complete(table, "ignex create --f", 16);
    expect(result).toContain("--features");
    expect(result).toContain("--force");
    expect(result).not.toContain("--runtime");
  });

  it("completes flag values from the preceding token", () => {
    expect(complete(table, "ignex create --runtime ", 23)).toEqual(["bun"]);
    expect(complete(table, "ignex create --runtime b", 24)).toEqual(["bun"]);
    expect(complete(table, "ignex create --pm n", 20)).toEqual(["npm"]);
  });

  it("completes special flag values (features / method / stage)", () => {
    expect(complete(table, "ignex create --features au", 26)).toEqual(["auth"]);
    expect(complete(table, "ignex route --method de", 23)).toEqual(["del"]);
    expect(complete(table, "ignex hook --global --stage aft", 31)).toEqual([
      "afterHandle",
      "afterResponse",
    ]);
  });

  it("completes shell names after `ignex completions`", () => {
    expect(complete(table, "ignex completions ", 18)).toEqual([...COMPLETION_SHELLS]);
    expect(complete(table, "ignex completions ba", 20)).toEqual(["bash"]);
  });

  it("returns nothing for path-like tokens (shell file fallback)", () => {
    expect(complete(table, "ignex build src", 15)).toEqual([]);
  });
});

describe("flagsFromArgs", () => {
  it("derives flags + enumerable values from typed args definitions", () => {
    const create = flagsFor("create");
    expect(create).toContainEqual({ flag: "--runtime", values: ["bun"] });
    expect(create).toContainEqual({ flag: "--pm", values: ["bun", "npm", "pnpm", "yarn"] });
    expect(create).toContainEqual({ flag: "--root" });
    // Default-true booleans surface their `--no-*` form.
    expect(create).toContainEqual({ flag: "--no-install" });
    expect(create.find((f) => f.flag === "--features")?.values).toEqual([...FEATURE_NAMES]);
  });

  it("maps the method / stage placeholders to their keyword values", () => {
    expect(flagsFor("route").find((f) => f.flag === "--method")?.values).toEqual([...HTTP_METHODS]);
    expect(flagsFor("hook").find((f) => f.flag === "--stage")?.values).toContain("afterHandle");
  });

  it("exposes ops targets as shell-completion values", () => {
    expect(flagsFor("ops").find((f) => f.flag === "--target")?.values).toEqual([
      "dockerfile",
      "compose",
      "caddy",
      "ci",
      "docker",
    ]);
  });
});

describe("_complete (hidden backend)", () => {
  it("prints newline-separated suggestions for --line/--cursor", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runComplete(["--line", "ignex create --runtime ", "--cursor", "23"]);
      // `--runtime` accepts only bun (the generated server requires Bun).
      expect(String(write.mock.calls[0]?.[0])).toBe("bun\n");
    } finally {
      write.mockRestore();
    }
  });

  it("prints nothing when there are no suggestions", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runComplete(["--line", "ignex build src", "--cursor", "15"]);
    expect(write.mock.calls.length).toBe(0);
    write.mockRestore();
  });

  it("resolves a response-file line (cmd/clink convention)", async () => {
    const tmp = join(tmpdir(), `ignex-complete-${Date.now()}.txt`);
    await writeFile(tmp, "ignex cre");
    try {
      const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await runComplete(["--line", `@${tmp}`, "--cursor", "9"]);
      expect(String(write.mock.calls[0]?.[0])).toBe("create\n");
      write.mockRestore();
    } finally {
      await rm(tmp, { force: true });
    }
  });
});

describe("completions command", () => {
  it.each([...COMPLETION_SHELLS] as const)("prints a script for %s", async (shell) => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runCompletions([shell]);
    const text = write.mock.calls.map((c) => String(c[0])).join("");
    const marker: Record<(typeof COMPLETION_SHELLS)[number], string> = {
      bash: "complete -o bashdefault",
      zsh: "#compdef ignex",
      fish: "complete -c ignex",
      powershell: "Register-ArgumentCompleter",
      cmd: "-- clink completion for ignex",
    };
    expect(text).toContain(marker[shell]);
    write.mockRestore();
  });
});
