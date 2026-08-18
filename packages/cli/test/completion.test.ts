import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runComplete } from "../src/commands/complete.js";
import { runCompletions } from "../src/commands/completions.js";
import { commands, findCommand, renderHelp } from "../src/commands/registry.js";
import { FEATURE_NAMES } from "../src/types.js";
import {
  COMPLETION_SHELLS,
  complete,
  HTTP_METHODS,
  parseFlagDocs,
  tokenizeLine,
} from "../src/utils/completion.js";

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
    expect(complete(commands, "ignex ", 6)).toContain("create");
    expect(complete(commands, "ignex ", 6)).toContain("completions");
    expect(complete(commands, "ignex cre", 9)).toEqual(["create"]);
    expect(complete(commands, "ignex r", 7)).toContain("route");
    expect(complete(commands, "ignex wa", 8)).toEqual(["watch"]);
  });

  it("does not surface hidden backend commands", () => {
    expect(complete(commands, "ignex _", 7)).not.toContain("_complete");
  });

  it("completes flags for a command", () => {
    const result = complete(commands, "ignex create --f", 16);
    expect(result).toContain("--features");
    expect(result).toContain("--force");
    expect(result).not.toContain("--runtime");
  });

  it("completes flag values from the preceding token", () => {
    expect(complete(commands, "ignex create --runtime ", 23)).toEqual(["bun", "node"]);
    expect(complete(commands, "ignex create --runtime b", 24)).toEqual(["bun"]);
    expect(complete(commands, "ignex create --pm n", 20)).toEqual(["npm"]);
  });

  it("completes special flag values (features / method / stage)", () => {
    expect(complete(commands, "ignex create --features au", 26)).toEqual(["auth"]);
    expect(complete(commands, "ignex route --method de", 23)).toEqual(["del"]);
    expect(complete(commands, "ignex hook --global --stage aft", 31)).toEqual([
      "afterHandle",
      "afterResponse",
    ]);
  });

  it("completes shell names after `ignex completions`", () => {
    expect(complete(commands, "ignex completions ", 18)).toEqual([...COMPLETION_SHELLS]);
    expect(complete(commands, "ignex completions ba", 20)).toEqual(["bash"]);
  });

  it("returns nothing for path-like tokens (shell file fallback)", () => {
    expect(complete(commands, "ignex build src", 15)).toEqual([]);
  });
});

describe("parseFlagDocs", () => {
  const create = commands.find((c) => c.name === "create");

  it("parses inline enum values from the option docs", () => {
    const flags = parseFlagDocs(create?.options);
    expect(flags).toContainEqual({ flag: "--runtime", values: ["bun", "node"] });
    expect(flags).toContainEqual({ flag: "--pm", values: ["bun", "npm", "pnpm", "yarn"] });
    expect(flags).toContainEqual({ flag: "--root" });
    expect(flags).toContainEqual({ flag: "--no-install" });
    expect(flags.find((f) => f.flag === "--features")?.values).toEqual([...FEATURE_NAMES]);
  });

  it("maps the method / stage placeholders to their keyword values", () => {
    const route = commands.find((c) => c.name === "route");
    expect(parseFlagDocs(route?.options).find((f) => f.flag === "--method")?.values).toEqual([
      ...HTTP_METHODS,
    ]);
    const hook = commands.find((c) => c.name === "hook");
    expect(parseFlagDocs(hook?.options).find((f) => f.flag === "--stage")?.values).toContain(
      "afterHandle",
    );
  });
});

describe("_complete (hidden backend)", () => {
  it("prints newline-separated suggestions for --line/--cursor", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runComplete(["--line", "ignex create --runtime ", "--cursor", "23"]);
    expect(String(write.mock.calls[0]?.[0])).toBe("bun\nnode\n");
    write.mockRestore();
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
      powershell: "Register-ArgumentCompleter -Native",
      cmd: "clink.argmatcher",
    };
    expect(text).toContain(marker[shell]);
    expect(text).toContain("ignex _complete --line");
    write.mockRestore();
  });

  it("errors on an unknown shell", async () => {
    const originalExitCode = process.exitCode;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runCompletions(["tcsh"]);
    expect(process.exitCode).toBe(1);
    process.exitCode = originalExitCode;
    err.mockRestore();
  });
});

describe("registry wiring", () => {
  it("finds the hidden _complete backend", () => {
    expect(findCommand("_complete")?.name).toBe("_complete");
    expect(findCommand("_complete")?.hidden).toBe(true);
  });

  it("hides _complete from help but shows completions", () => {
    const help = renderHelp();
    expect(help).toContain("completions");
    expect(help).not.toContain("_complete");
  });
});
