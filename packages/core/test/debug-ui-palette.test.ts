/**
 * @fileoverview Command-palette pure-logic tests.
 *
 * The view registry is a Solid `.tsx` module that cannot be transformed under
 * the repo's `jsx: "preserve"` test config, so it is stubbed from the parsed
 * registry source (see `helpers/debug-ui-registry.ts`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCommands, type Command, filterCommands, fuzzyScore } from "../src/debug/ui/palette";

vi.mock("../src/debug/ui/views/registry", async () => {
  const { registryViews } = await import("./helpers/debug-ui-registry");
  return {
    VIEWS: registryViews().map(({ id, label }) => ({
      id,
      label,
      key: "",
      domain: null,
      component: () => null,
    })),
  };
});

const c = (label: string): Command => ({ id: label, label, group: "Views", run: () => {} });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("filterCommands", () => {
  it("returns everything for an empty query", () => {
    expect(filterCommands([c("Requests"), c("Logs")], "").map((x) => x.label)).toEqual([
      "Requests",
      "Logs",
    ]);
  });
  it("matches subsequences case-insensitively", () => {
    expect(filterCommands([c("Diagnostics"), c("Docs")], "dcs").map((x) => x.label)).toEqual([
      "Docs",
      "Diagnostics",
    ]);
  });
  it("drops non-matches", () => {
    expect(filterCommands([c("Requests")], "zzz")).toEqual([]);
  });

  it("treats a whitespace-only query as empty", () => {
    expect(filterCommands([c("Requests")], "   ").map((x) => x.label)).toEqual(["Requests"]);
  });

  it("breaks score ties by label", () => {
    // Both match at identical offsets, so scores tie and label order decides.
    const same = [c("Items B"), c("Items A")];
    expect(filterCommands(same, "items").map((x) => x.label)).toEqual(["Items A", "Items B"]);
  });

  it("does not mutate the input order", () => {
    const cmds = [c("Logs"), c("Requests")];
    filterCommands(cmds, "");
    expect(cmds.map((x) => x.label)).toEqual(["Logs", "Requests"]);
  });
});

describe("fuzzyScore", () => {
  it("scores exact prefixes highest", () => {
    expect(fuzzyScore("req", "Requests")).toBeGreaterThan(fuzzyScore("req", "ErroReQuest"));
  });

  it("returns -Infinity when the query is not a subsequence", () => {
    expect(fuzzyScore("zzz", "Requests")).toBe(-Infinity);
    expect(fuzzyScore("x", "Requests")).toBe(-Infinity);
  });

  it("matches case-insensitively", () => {
    expect(fuzzyScore("REQ", "requests")).toBe(fuzzyScore("req", "Requests"));
  });

  it("returns 0 for an empty query", () => {
    expect(fuzzyScore("", "Requests")).toBe(0);
  });
});

describe("buildCommands", () => {
  const deps = () => ({
    navigate: vi.fn(),
    toggleTheme: vi.fn(),
    refresh: vi.fn(),
    togglePause: vi.fn(),
  });

  it("builds 15 view commands in sidebar order", () => {
    const views = buildCommands(deps()).filter((cmd) => cmd.group === "Views");
    expect(views.map((cmd) => cmd.label)).toEqual([
      "Requests",
      "Errors",
      "Logs",
      "History",
      "Routes",
      "Metrics",
      "System",
      "Diagnostics",
      "State",
      "Jobs",
      "Events",
      "Clients",
      "KT",
      "Docs",
      "AI",
    ]);
  });

  it("builds the action and go-to groups", () => {
    const cmds = buildCommands(deps());
    expect(cmds.filter((cmd) => cmd.group === "Actions").map((cmd) => cmd.label)).toEqual([
      "Refresh",
      "Toggle live tail",
      "Toggle theme",
    ]);
    expect(cmds.filter((cmd) => cmd.group === "Go to").map((cmd) => cmd.label)).toEqual([
      "Open request by id",
      "Open log by id",
      "Open doc by path",
    ]);
    expect(cmds).toHaveLength(21);
  });

  it("wires view and action commands to deps", () => {
    const d = deps();
    const cmds = buildCommands(d);
    cmds.find((cmd) => cmd.label === "Requests")?.run();
    expect(d.navigate).toHaveBeenCalledWith("requests");
    cmds.find((cmd) => cmd.label === "Toggle live tail")?.run();
    expect(d.togglePause).toHaveBeenCalledTimes(1);
    cmds.find((cmd) => cmd.label === "Refresh")?.run();
    expect(d.refresh).toHaveBeenCalledTimes(1);
    cmds.find((cmd) => cmd.label === "Toggle theme")?.run();
    expect(d.toggleTheme).toHaveBeenCalledTimes(1);
  });

  it("prompts inline for the go-to commands", () => {
    vi.stubGlobal(
      "prompt",
      vi.fn(() => "abc"),
    );
    const d = deps();
    const cmds = buildCommands(d);
    cmds.find((cmd) => cmd.label === "Open request by id")?.run();
    expect(d.navigate).toHaveBeenCalledWith("detail", "abc");
    cmds.find((cmd) => cmd.label === "Open log by id")?.run();
    expect(d.navigate).toHaveBeenCalledWith("logDetail", "abc");
    cmds.find((cmd) => cmd.label === "Open doc by path")?.run();
    expect(d.navigate).toHaveBeenCalledWith("docs", "abc");
  });

  it("does nothing when an inline prompt is dismissed", () => {
    vi.stubGlobal(
      "prompt",
      vi.fn(() => null),
    );
    const d = deps();
    buildCommands(d)
      .find((cmd) => cmd.label === "Open request by id")
      ?.run();
    expect(d.navigate).not.toHaveBeenCalled();
  });
});
