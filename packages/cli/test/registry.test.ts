import { describe, expect, it } from "vitest";
import { commands, findCommand, renderHelp } from "../src/commands/registry.js";

describe("registry", () => {
  it("declares the core commands", () => {
    const names = commands.map((c) => c.name);
    expect(names).toContain("create");
    expect(names).toContain("dev");
    expect(names).toContain("build");
    expect(names).toContain("route");
    expect(names).toContain("info");
  });

  it("finds commands by name and alias", () => {
    expect(findCommand("dev")?.name).toBe("dev");
    expect(findCommand("watch")?.name).toBe("dev");
    expect(findCommand("init")?.name).toBe("create");
    expect(findCommand("r")?.name).toBe("route");
    expect(findCommand("does-not-exist")).toBeUndefined();
  });

  it("renders help that documents dev flags", () => {
    const help = renderHelp();
    expect(help).toContain("dev");
    expect(help).toContain("--no-spawn");
    expect(help).toContain("--verbose");
    expect(help).toContain("build");
  });
});
