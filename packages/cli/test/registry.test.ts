import { describe, expect, it } from "vitest";
import { commands, findCommand, renderCommandHelp, renderHelp } from "../src/commands/registry.js";
import { cliVersion } from "../src/version.js";

describe("registry", () => {
  it("declares the core commands", () => {
    const names = commands.map((c) => c.name);
    expect(names).toContain("create");
    expect(names).toContain("dev");
    expect(names).toContain("build");
    expect(names).toContain("route");
    expect(names).toContain("ops");
    expect(names).toContain("info");
  });

  it("finds commands by name and alias", () => {
    expect(findCommand("dev")?.name).toBe("dev");
    expect(findCommand("watch")?.name).toBe("dev");
    expect(findCommand("init")?.name).toBe("create");
    expect(findCommand("r")?.name).toBe("route");
    expect(findCommand("devops")?.name).toBe("ops");
    expect(findCommand("does-not-exist")).toBeUndefined();
  });

  it("renders help that documents dev flags", () => {
    const help = renderHelp();
    expect(help).toContain("dev");
    expect(help).toContain("--no-spawn");
    expect(help).toContain("--verbose");
    expect(help).toContain("build");
  });

  it("renders ops help with targets and db flags", () => {
    const help = renderHelp();
    expect(help).toContain("ops");
    expect(help).toContain("dockerfile | compose | caddy | ci | docker");
    expect(help).toContain("--db-user");
    expect(help).toContain("--db-password");
    expect(help).toContain("--replica");
    expect(help).toContain("--domain");
  });

  it("renders help grouped by section", () => {
    const help = renderHelp();
    expect(help).toContain("Scaffold");
    expect(help).toContain("Develop");
    expect(help).toContain("Deploy");
    expect(help).toContain("Integrate");
  });

  it("declares the event wizard command", () => {
    expect(findCommand("event")?.name).toBe("event");
    expect(findCommand("events")?.name).toBe("event");
  });

  it("documents the module + kill-port flags in help", () => {
    const help = renderHelp();
    expect(help).toContain("--no-module");
    expect(help).toContain("--kill-port");
    expect(help).toContain("--services");
    expect(help).toContain("--redis-password");
  });

  it("renders per-command help with usage and options", () => {
    const route = findCommand("route");
    expect(route).toBeDefined();
    if (!route) return;
    const help = renderCommandHelp(route);
    expect(help).toContain("Usage:");
    expect(help).toContain("ignex route");
    expect(help).toContain("--no-module");
    expect(help).toContain("Route path");
  });

  it("reports a semver version", () => {
    expect(cliVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

it("declares the tinker REPL command", () => {
  expect(findCommand("tinker")?.name).toBe("tinker");
  expect(findCommand("repl")?.name).toBe("tinker");
  expect(findCommand("console")?.name).toBe("tinker");
  const help = renderHelp();
  expect(help).toContain("tinker");
  expect(help).toContain("--no-db");
});

it("declares route:list with json + method filters", () => {
  expect(findCommand("route:list")?.name).toBe("route:list");
  expect(findCommand("rl")?.name).toBe("route:list");
  const help = renderCommandHelp(findCommand("route:list") as never);
  expect(help).toContain("--json");
  expect(help).toContain("--methods");
});
