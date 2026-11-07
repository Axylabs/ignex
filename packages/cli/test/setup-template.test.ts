/**
 * Tests for the base-project setup templates (`templates/setup.ts`) — the
 * turnkey bootstrap story: setup.sh / setup.bat install Bun when missing and
 * hand off to scripts/setup.ts, the cross-platform provisioner. These assert
 * the generated SOURCE (the templates are pure string functions); the
 * end-to-end `--check` run lives in create.test.ts.
 */

import { describe, expect, it } from "vitest";
import { setupBatTemplate, setupShTemplate, setupTsTemplate } from "../src/templates/setup.js";

describe("setupShTemplate", () => {
  it("detects a missing Bun, installs it via the official installer, then hands off", () => {
    const sh = setupShTemplate();
    expect(sh).toContain("has bun");
    expect(sh).toContain("https://bun.sh/install | bash");
    // wget fallback when curl is absent, PATH fix after a fresh install.
    expect(sh).toContain("wget -qO- https://bun.sh/install | bash");
    expect(sh).toContain("$HOME/.bun/bin:$PATH");
    // Provisioner hand-off preserves the caller's flags.
    expect(sh).toContain('exec bun scripts/setup.ts "$@"');
  });

  it("can bootstrap curl itself when no downloader exists", () => {
    const sh = setupShTemplate();
    for (const pm of ["apt-get", "apk", "dnf", "pacman", "zypper", "brew"]) {
      expect(sh).toContain(pm);
    }
  });

  it("stays POSIX sh compatible (no bash-only constructs)", () => {
    const sh = setupShTemplate();
    expect(sh.startsWith("#!/usr/bin/env sh\n")).toBe(true);
    expect(sh).not.toContain("[[");
    expect(sh).not.toContain("declare -a");
  });
});

describe("setupBatTemplate", () => {
  it("detects a missing Bun via where, installs via the PowerShell installer", () => {
    const bat = setupBatTemplate();
    expect(bat).toContain("where bun");
    expect(bat).toContain("irm bun.sh/install.ps1 | iex");
    // Hand-off to the provisioner, preserving arguments.
    expect(bat).toContain("bun scripts\\setup.ts %*");
  });

  it("uses goto flow (no %errorlevel% inside parenthesized blocks)", () => {
    const bat = setupBatTemplate();
    expect(bat).toContain("goto have_bun");
    expect(bat).toContain(":install_failed");
  });

  it("bakes CRLF line endings (cmd.exe mis-parses LF-only batch files)", () => {
    const bat = setupBatTemplate();
    expect(bat.includes("\r\n")).toBe(true);
    // Every line break is CRLF — a bare LF would break cmd parsing.
    expect(bat.replace(/\r\n/g, "")).not.toContain("\n");
  });
});

describe("setupTsTemplate", () => {
  const ts = setupTsTemplate();

  it("is a Bun-shell script (the multi-OS layer) that never shells out to sh syntax", () => {
    expect(ts).toContain('import { $ } from "bun"');
    // Probes use Bun.which — no `command -v` round-trips (broken on Windows).
    expect(ts).toContain("Bun.which");
    expect(ts).not.toContain("command -v");
  });

  it("detects the OS via /etc/os-release and probes the known package managers", () => {
    expect(ts).toContain("/etc/os-release");
    for (const pm of [
      "apt-get",
      "apk",
      "dnf",
      "pacman",
      "zypper",
      "brew",
      "winget",
      "choco",
      "scoop",
    ]) {
      expect(ts).toContain(`"${pm}"`);
    }
  });

  it("supports the detection-only report and the provisioning flags", () => {
    expect(ts).toContain('"--check"');
    expect(ts).toContain('"--docker"');
    expect(ts).toContain('"--caddy"');
    expect(ts).toContain('"--systemd"');
    expect(ts).toContain('"--help"');
    expect(ts).toContain("JSON.stringify(report, null, 2)");
  });

  it("default stages: env → install → build → smoke-test the compiled server", () => {
    expect(ts).toContain('copyFileSync(".env.example", ".env")');
    expect(ts).toContain('"bun", "install"');
    expect(ts).toContain('"bun", "run", "build"');
    // Smoke: spawn the artifact, poll the framework health contract, then kill.
    expect(ts).toContain('".ignex/server.js"');
    expect(ts).toContain("IGNEX_HTTPS");
    expect(ts).toContain("/health");
  });

  it("reads the exit code from the awaited shell result (the promise is not thenable)", () => {
    expect(ts).toContain("const res = await $");
    expect(ts).toContain("res.exitCode");
  });

  it("official-repo installs run as root scripts, removed after either outcome", () => {
    expect(ts).toContain("download.docker.com");
    expect(ts).toContain("dl.cloudsmith.io/public/caddy/stable");
    expect(ts).toContain("rmSync(path, { force: true })");
  });
});
