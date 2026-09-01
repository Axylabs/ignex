import { describe, expect, it } from "vitest";
import { loadCommand } from "../src/commands/loaders.js";
import { commands, findCommand, renderRootHelp } from "../src/commands/registry.js";
import { renderCommandHelp } from "../src/usage.js";
import { cliVersion } from "../src/version.js";

/** Help for a command by registry name/alias, via the lazy citty loader. */
const helpFor = async (nameOrAlias: string): Promise<string> => {
  const cmd = await loadCommand(nameOrAlias);
  expect(cmd).toBeDefined();
  return renderCommandHelp(cmd as never);
};

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

  it("renders root help that documents the command surface", () => {
    const help = renderRootHelp();
    expect(help).toContain("dev");
    expect(help).toContain("build");
    expect(help).toContain("create my-app");
  });

  it("renders per-command help with the dev flags", async () => {
    const help = await helpFor("dev");
    expect(help).toContain("--no-spawn");
    expect(help).toContain("--verbose");
    expect(help).toContain("--kill-port");
  });

  it("renders ops help with targets and db flags", async () => {
    const help = await helpFor("ops");
    expect(help).toContain("dockerfile|compose|caddy|ci|docker");
    expect(help).toContain("--db-user");
    expect(help).toContain("--db-password");
    expect(help).toContain("--replica");
    expect(help).toContain("--domain");
  });

  it("renders help grouped by section", () => {
    const help = renderRootHelp();
    expect(help).toContain("Scaffold");
    expect(help).toContain("Develop");
    expect(help).toContain("Ship");
    expect(help).toContain("Integrate");
  });

  it("declares the event wizard command", () => {
    expect(findCommand("event")?.name).toBe("event");
    expect(findCommand("events")?.name).toBe("event");
  });

  it("documents the module + kill-port flags in help", async () => {
    const route = await helpFor("route");
    expect(route).toContain("--no-module");
    const dev = await helpFor("dev");
    expect(dev).toContain("--kill-port");
    const ops = await helpFor("ops");
    expect(ops).toContain("--services");
    expect(ops).toContain("--redis-password");
  });

  it("renders per-command help with usage and options", async () => {
    const help = await helpFor("route");
    expect(help).toContain("USAGE");
    expect(help).toContain("route [OPTIONS]");
    expect(help).toContain("--no-module");
    expect(help).toContain("Route path");
  });

  it("reports a semver version", () => {
    expect(cliVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

it("declares the tinker REPL command", async () => {
  expect(findCommand("tinker")?.name).toBe("tinker");
  expect(findCommand("repl")?.name).toBe("tinker");
  expect(findCommand("console")?.name).toBe("tinker");
  const help = await helpFor("tinker");
  expect(help).toContain("--no-db");
});

it("declares route:list with json + method filters", async () => {
  expect(findCommand("route:list")?.name).toBe("route:list");
  expect(findCommand("rl")?.name).toBe("route:list");
  const help = await helpFor("route:list");
  expect(help).toContain("--json");
  expect(help).toContain("--methods");
});

it("declares the factory scaffold command", async () => {
  expect(findCommand("factory")?.name).toBe("factory");
  expect(findCommand("make:factory")?.name).toBe("factory");
  const help = await helpFor("factory");
  expect(help).toContain("--fields");
  expect(help).toContain("--force");
});

it("declares schedule:run with a --once flag", async () => {
  expect(findCommand("schedule:run")?.name).toBe("schedule:run");
  expect(findCommand("schedule")?.name).toBe("schedule:run");
  const help = await helpFor("schedule:run");
  expect(help).toContain("--once");
});

it("declares queue:work with --once and --init", async () => {
  expect(findCommand("queue:work")?.name).toBe("queue:work");
  expect(findCommand("queue")?.name).toBe("queue:work");
  const help = await helpFor("queue:work");
  expect(help).toContain("--once");
  expect(help).toContain("--init");
});
