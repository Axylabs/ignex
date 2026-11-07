/**
 * @fileoverview Base-project setup templates — the turnkey bootstrap story for
 * every scaffolded ignex app:
 *
 *   setup.sh (macOS/Linux) / setup.bat (Windows)   install Bun if missing,
 *                                                  then hand off to the
 *                                                  provisioner below
 *   scripts/setup.ts                               the cross-platform
 *                                                  provisioner (Bun shell):
 *                                                  detect OS + package
 *                                                  manager, install missing
 *                                                  tooling, .env → install →
 *                                                  build → smoke-test
 *
 * Pure functions, string in → string out (same convention as `ops-*.ts`).
 * `setupShTemplate`/`setupTsTemplate` output LF text; `setupBatTemplate`
 * bakes CRLF line endings (generated projects have no `.gitattributes`, and
 * cmd.exe mis-parses LF-only batch files).
 */

/**
 * Bootstrap for POSIX shells (macOS + Linux): make sure `bun` is on PATH —
 * installing it through the official installer when missing, best-effort
 * installing `curl` through the detected system package manager first — then
 * exec the cross-platform provisioner.
 */
export function setupShTemplate(): string {
  return `#!/usr/bin/env sh
# setup.sh — bootstrap this ignex project on macOS/Linux.
#
# Installs Bun (https://bun.sh) when it is missing — including a best-effort
# curl install through the system package manager when neither curl nor wget
# is present — then hands off to scripts/setup.ts, the cross-platform
# provisioner (OS/package-manager detection, tooling, build + smoke test).
#
# Usage: ./setup.sh [--check | --docker | --caddy | --systemd]   # see:
#        bun scripts/setup.ts --help
set -eu

has() { command -v "$1" >/dev/null 2>&1; }

# as_root CMD... — plain CMD as root, sudo CMD otherwise.
as_root() {
  if [ "$(id -u)" = "0" ] || ! has sudo; then "$@"; else sudo "$@"; fi
}

if ! has bun; then
  echo "==> Bun not found — installing (https://bun.sh) ..."
  if ! has curl && ! has wget; then
    echo "==> Neither curl nor wget found — installing curl via the system package manager ..."
    if has apt-get; then as_root apt-get update && as_root apt-get install -y curl
    elif has apk; then as_root apk add curl
    elif has dnf; then as_root dnf install -y curl
    elif has pacman; then as_root pacman -S --noconfirm curl
    elif has zypper; then as_root zypper install --non-interactive curl
    elif has brew; then brew install curl
    else
      echo "error: no package manager found — install Bun manually:" >&2
      echo "  https://bun.sh/docs/installation" >&2
      exit 1
    fi
  fi
  if has curl; then curl -fsSL https://bun.sh/install | bash
  else wget -qO- https://bun.sh/install | bash
  fi
  export PATH="$HOME/.bun/bin:$PATH"
fi

echo "==> Bun $(bun --version) — provisioning the project ..."
exec bun scripts/setup.ts "$@"
`;
}

/**
 * Windows bootstrap: make sure `bun` is on PATH — installing it through the
 * official PowerShell installer when missing — then run the provisioner.
 * The output uses CRLF line endings (cmd.exe requirement; see the
 * {@linkcode setupBatTemplate} file docs).
 */
export function setupBatTemplate(): string {
  return [
    "@echo off",
    "REM setup.bat - bootstrap this ignex project on Windows.",
    "REM Installs Bun (https://bun.sh) when missing via the official PowerShell",
    "REM installer, then runs scripts\\setup.ts - the cross-platform provisioner.",
    "REM Usage: setup.bat [--check | --docker | --caddy | --systemd]",
    "setlocal",
    "where bun >nul 2>nul",
    "if %errorlevel% equ 0 goto have_bun",
    "echo ==^> Bun not found - installing via PowerShell (https://bun.sh) ...",
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"',
    "if %errorlevel% neq 0 goto install_failed",
    'set "PATH=%USERPROFILE%\\.bun\\bin;%PATH%"',
    ":have_bun",
    "echo ==^> Bun provisioner (scripts\\setup.ts) ...",
    "bun scripts\\setup.ts %*",
    "goto done",
    ":install_failed",
    "echo error: Bun installation failed - install manually: https://bun.sh/docs/installation",
    "exit /b 1",
    ":done",
    "endlocal",
    "",
  ].join("\r\n");
}

/**
 * The provisioner emitted as `scripts/setup.ts` in every scaffolded project.
 * Written against Bun's cross-platform shell (`import { $ } from "bun"`), so
 * the same script provisions macOS, Linux and Windows. NOTE: the script body
 * is embedded as source — inner template literals are escaped into this
 * outer one.
 */
export function setupTsTemplate(): string {
  return `#!/usr/bin/env bun
/**
 * scripts/setup.ts — provision this machine for the ignex workflow.
 *
 * ./setup.sh (macOS/Linux) / setup.bat (Windows) install Bun when missing and
 * run this script. Every command goes through Bun's cross-platform shell
 * ($ from "bun"), so the same provisioner works on macOS, Linux and Windows:
 *
 *   bun scripts/setup.ts            default: .env -> install -> build -> smoke
 *   bun scripts/setup.ts --check    detect OS / package manager / tools (JSON)
 *   bun scripts/setup.ts --docker   install Docker Engine + compose plugin
 *   bun scripts/setup.ts --caddy    install Caddy
 *   bun scripts/setup.ts --systemd  generate units via \`ignex ops systemd\`
 *   bun scripts/setup.ts --help     full usage
 *
 * Idempotent: every stage detects what is already present and skips it.
 * Run from the project root.
 */

import { $ } from "bun";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- output -------------------------------------------------------------------

const step = (msg: string): void => console.log(\`\\n==> \${msg}\`);
const info = (msg: string): void => console.log(\`    \${msg}\`);
const warn = (msg: string): void => console.warn(\`    warning: \${msg}\`);
const die = (msg: string): never => {
  console.error(\`    error: \${msg}\`);
  process.exit(1);
};

// ---- detection ----------------------------------------------------------------

interface OsInfo {
  platform: NodeJS.Platform;
  family: "linux" | "mac" | "windows";
  /** /etc/os-release ID (linux only) — "ubuntu", "debian", "arch", ... */
  distro?: string;
  /** /etc/os-release VERSION_ID (linux only). */
  version?: string;
  /** /etc/os-release VERSION_CODENAME (apt-family only) — "bookworm", "jammy". */
  codename?: string;
  /** /etc/os-release ID_LIKE (linux only) — distro-family hints. */
  like?: string;
}

function detectOs(): OsInfo {
  const platform = process.platform;
  if (platform === "win32") return { platform, family: "windows" };
  if (platform === "darwin") return { platform, family: "mac" };
  const os: OsInfo = { platform, family: "linux" };
  try {
    const raw = readFileSync("/etc/os-release", "utf8");
    // Line scan instead of a regex — os-release values may be quoted.
    const field = (name: string): string | undefined => {
      for (const line of raw.split("\\n")) {
        if (!line.startsWith(name + "=")) continue;
        return line.slice(name.length + 1).replace(/^["']|["']$/g, "") || undefined;
      }
      return undefined;
    };
    os.distro = field("ID");
    os.version = field("VERSION_ID");
    os.codename = field("VERSION_CODENAME") ?? field("UBUNTU_CODENAME");
    os.like = field("ID_LIKE");
  } catch {
    // /etc/os-release missing — detection stays partial, stages degrade.
  }
  return os;
}

/** Command on PATH? Bun.which — a cross-platform \`which\` with no shell round-trip. */
const has = (cmd: string): boolean => Bun.which(cmd) !== null;

/** Probe order matters: the first match wins (apt-get before apk, ...). */
const PACKAGE_MANAGERS = [
  "apt-get",
  "apk",
  "dnf",
  "pacman",
  "zypper",
  "brew",
  "winget",
  "choco",
  "scoop",
] as const;

const detectPackageManager = (): string | null => PACKAGE_MANAGERS.find((pm) => has(pm)) ?? null;

const isRoot = (): boolean => typeof process.getuid === "function" && process.getuid() === 0;

/** Prefix a command with sudo when running as a non-root user with sudo present. */
const asRoot = (argv: string[]): string[] =>
  !isRoot() && has("sudo") ? ["sudo", ...argv] : argv;

const PM_INSTALL: Record<string, string[]> = {
  "apt-get": ["apt-get", "install", "-y"],
  apk: ["apk", "add"],
  dnf: ["dnf", "install", "-y"],
  pacman: ["pacman", "-S", "--noconfirm"],
  zypper: ["zypper", "install", "--non-interactive"],
  brew: ["brew", "install"],
  winget: ["winget", "install", "--accept-source-agreements", "--accept-package-agreements", "--id"],
  choco: ["choco", "install", "-y"],
  scoop: ["scoop", "install"],
};

// ---- shell helpers ------------------------------------------------------------

/** Run one command (argv) through Bun's shell, inheriting output. */
async function runArgs(argv: string[]): Promise<boolean> {
  info("+ " + argv.join(" "));
  // NOTE: the array-interpolated shell promise is not thenable — the exit
  // code exists only on the awaited result.
  const res = await $\`\${argv}\`.nothrow();
  if (res.exitCode !== 0) warn(\`\${argv[0]} exited with code \${res.exitCode}\`);
  return res.exitCode === 0;
}

/**
 * Write a shell script to a temp file and run it through asRoot(bash) — the
 * escape hatch for the multi-step official-repo installs (Docker, Caddy),
 * which need root and heredoc-free ordering. Never half-applies: the script
 * is \`set -eu\` and removed afterwards either way.
 */
async function runRootScript(label: string, script: string): Promise<boolean> {
  const path = join(tmpdir(), \`ignex-setup-\${label}-\${Date.now()}.sh\`);
  writeFileSync(path, "#!/usr/bin/env bash\\nset -euo pipefail\\n" + script + "\\n", { mode: 0o700 });
  const ok = await runArgs(asRoot(["bash", path]));
  rmSync(path, { force: true });
  return ok;
}

/** Install packages through the detected package manager. */
async function pmInstall(pm: string | null, packages: string[]): Promise<boolean> {
  if (!pm) {
    warn(\`no package manager detected — install manually: \${packages.join(" ")}\`);
    return false;
  }
  const front = PM_INSTALL[pm];
  if (!front) return false;
  return runArgs(asRoot([...front, ...packages]));
}

// ---- stages -------------------------------------------------------------------

/** Copy .env.example to .env when the project has no .env yet. */
function envStage(): void {
  if (existsSync(".env")) {
    info(".env exists — left untouched");
    return;
  }
  if (!existsSync(".env.example")) {
    warn("no .env.example — skipping the env stage");
    return;
  }
  copyFileSync(".env.example", ".env");
  info("created .env from .env.example — adjust values as needed");
}

/** Make sure git is available (best-effort: warn when no package manager). */
async function gitStage(pm: string | null): Promise<void> {
  if (has("git")) {
    info("git already present");
    return;
  }
  step("Installing git");
  if (!(await pmInstall(pm, ["git"]))) {
    warn("git is missing — version control workflows need it (https://git-scm.com)");
  }
}

async function depsStage(): Promise<void> {
  step("Installing dependencies (bun install)");
  const frozen = existsSync("bun.lock");
  if (!(await runArgs(["bun", "install", ...(frozen ? ["--frozen-lockfile"] : [])]))) {
    die("bun install failed — fix the error above and re-run");
  }
}

async function buildStage(): Promise<void> {
  step("Building the production artifact (bun run build)");
  if (!(await runArgs(["bun", "run", "build"]))) {
    die("build failed — fix the error above and re-run");
  }
}

/** First port at/after \\pstart\\p with nothing listening (bind probe, up to +19). */
function freePort(start: number): number {
  for (let port = start; port < start + 20; port++) {
    try {
      const listener = Bun.listen({
        hostname: "127.0.0.1",
        port,
        socket: {
          open() {},
          data() {},
          close() {},
          drain() {},
          end() {},
          error() {},
        },
      });
      listener.stop(true);
      return port;
    } catch {
      // port taken — try the next one
    }
  }
  return start;
}

/** Build → run the compiled server → poll GET /health → kill. The proof the */
/** scaffolded project actually works on this machine. */
async function smokeStage(): Promise<void> {
  step("Smoke test — booting the compiled server");
  if (!existsSync(".ignex/server.js")) die("no .ignex/server.js — run the build stage first");
  const port = freePort(readPortFromEnv() + 1);
  const proc = Bun.spawn([process.execPath, ".ignex/server.js"], {
    env: { ...process.env, IGNEX_HTTPS: "0", NODE_ENV: "production", PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const deadline = Date.now() + 20_000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(\`http://127.0.0.1:\${port}/health\`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      await Bun.sleep(300);
    }
  }
  proc.kill();
  await proc.exited;
  if (!healthy) {
    const stderr = await new Response(proc.stderr).text();
    warn("the server did not answer GET /health within 20s — stderr tail:");
    console.error(
      stderr
        .split("\\n")
        .slice(-8)
        .join("\\n"),
    );
    die("smoke test failed");
  }
  info(\`GET http://127.0.0.1:\${port}/health answered 200 — the app boots and serves\`);
}

/** PORT from .env (default 3000) — the smoke test probes the next free port. */
function readPortFromEnv(): number {
  if (!existsSync(".env")) return 3000;
  const match = readFileSync(".env", "utf8").match(/^PORT=(\\d+)/m);
  const port = match?.[1] ? Number(match[1]) : NaN;
  return Number.isInteger(port) && port > 0 && port < 65535 ? port : 3000;
}

// ---- opt-in provisioning stages -------------------------------------------------

/** Docker Engine + compose plugin, from the official repositories. */
async function dockerStage(os: OsInfo, pm: string | null): Promise<void> {
  step("Provisioning Docker Engine + compose plugin");
  if (has("docker")) {
    info("docker already present — skipping");
    return;
  }
  if (os.family === "mac") {
    warn("macOS: install Docker Desktop (https://docs.docker.com/desktop/install/mac-install/)");
    warn("  or the CLI-only stack: brew install colima docker && colima start");
    process.exitCode = 1;
    return;
  }
  if (os.family === "windows") {
    warn("Windows: install Docker Desktop (https://docs.docker.com/desktop/install/windows-install/)");
    process.exitCode = 1;
    return;
  }
  const family = aptFamily(os) ? "apt" : os.distro === "fedora" || os.like?.includes("fedora") || os.like?.includes("rhel") ? "dnf" : os.distro;
  if (family === "apt") {
    const target = os.distro === "ubuntu" || os.like?.includes("ubuntu") ? "ubuntu" : "debian";
    if (!os.codename) die("cannot determine the release codename for Docker's apt repository");
    await runRootScript(
      "docker-apt",
      \`install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/\${target}/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/\${target} \${os.codename} stable" > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
\`,
    );
  } else if (family === "dnf") {
    const target = os.distro === "fedora" ? "fedora" : "centos";
    await runRootScript(
      "docker-dnf",
      \`dnf -y install dnf-plugins-core
dnf config-manager --add-repo https://download.docker.com/linux/\${target}/docker-ce.repo
dnf -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable --now docker
\`,
    );
  } else if (os.distro === "arch" || os.like?.includes("arch")) {
    await runRootScript("docker-pacman", "pacman -S --noconfirm docker docker-compose\\nsystemctl enable --now docker\\n");
  } else if (os.distro === "alpine") {
    await runRootScript("docker-apk", "apk add docker docker-cli-compose\\nrc-update add docker default\\nservice docker start\\n");
  } else {
    warn(\`unsupported distribution '\${os.distro ?? "unknown"}' — install Docker manually:\`);
    warn("  https://docs.docker.com/engine/install/");
    process.exitCode = 1;
    return;
  }
  if (has("docker")) info("docker installed");
  else warn("docker not on PATH after installation — open a new shell and re-run --check");
}

/** Caddy, from the official repositories. */
async function caddyStage(os: OsInfo, pm: string | null): Promise<void> {
  step("Provisioning Caddy");
  if (has("caddy")) {
    info("caddy already present — skipping");
    return;
  }
  if (os.family === "mac") {
    if (!(await pmInstall("brew", ["caddy"]))) die("caddy install failed");
    return;
  }
  if (os.family === "windows") {
    if (pm === "scoop" && (await runArgs(["scoop", "install", "caddy"]))) return;
    if (pm === "choco" && (await runArgs(["choco", "install", "-y", "caddy"]))) return;
    if (pm === "winget" && (await runArgs(["winget", "install", "--accept-source-agreements", "--accept-package-agreements", "--id", "CaddyServer.Caddy"]))) return;
    warn("install Caddy manually: https://caddyserver.com/docs/install#windows");
    process.exitCode = 1;
    return;
  }
  if (aptFamily(os)) {
    await runRootScript(
      "caddy-apt",
      \`apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq
apt-get install -y caddy
\`,
    );
  } else if (os.distro === "fedora" || os.like?.includes("fedora") || os.like?.includes("rhel")) {
    await runRootScript(
      "caddy-dnf",
      "dnf -y install dnf-plugins-core\\ndnf copr enable -y @caddy/caddy\\ndnf -y install caddy\\n",
    );
  } else if (os.distro === "arch" || os.like?.includes("arch")) {
    await runRootScript("caddy-pacman", "pacman -S --noconfirm caddy\\n");
  } else if (os.distro === "alpine") {
    await runRootScript("caddy-apk", "apk add caddy\\n");
  } else {
    warn(\`unsupported distribution '\${os.distro ?? "unknown"}' — install Caddy manually:\`);
    warn("  https://caddyserver.com/docs/install");
    process.exitCode = 1;
    return;
  }
  if (has("caddy")) info("caddy installed");
  else warn("caddy not on PATH after installation — open a new shell and re-run --check");
}

/** Generate hardened systemd units + a deploy script via \`ignex ops systemd\`. */
async function systemdStage(): Promise<void> {
  step("Generating systemd units (ignex ops systemd)");
  const ok = await runArgs(["bunx", "ignex", "ops", "systemd", "--force"]);
  if (!ok) {
    warn("this @ignex/cli has no systemd target — upgrade it: bun update @ignex/cli");
    return;
  }
  info("next: review deploy/, then per the generator's output:");
  info("  sudo cp deploy/*.service /etc/systemd/system/ && sudo systemctl daemon-reload");
  info("  sudo systemctl enable --now <name>.service");
}

const aptFamily = (os: OsInfo): boolean =>
  os.distro === "debian" ||
  os.distro === "ubuntu" ||
  (os.like?.includes("debian") ?? false) ||
  (os.like?.includes("ubuntu") ?? false);

// ---- entry --------------------------------------------------------------------

const USAGE = \`Usage: bun scripts/setup.ts [stage]

Stages (idempotent, composable):
  (default)   .env -> bun install -> build -> smoke-test the compiled server
  --check     detect OS / package manager / tooling; print a JSON report
  --docker    install Docker Engine + compose plugin (official repositories)
  --caddy     install Caddy (official repositories)
  --systemd   generate hardened units + deploy script via ignex ops systemd
  --help      this text

Flags combine: bun scripts/setup.ts --docker --caddy --systemd
\`;

function printCheck(os: OsInfo, pm: string | null): void {
  const report = {
    os: { platform: os.platform, family: os.family, distro: os.distro, version: os.version, like: os.like },
    packageManager: pm,
    tools: { bun: process.version, git: has("git"), curl: has("curl"), docker: has("docker"), caddy: has("caddy") },
    project: {
      envFile: existsSync(".env"),
      envExample: existsSync(".env.example"),
      lockfile: existsSync("bun.lock"),
      built: existsSync(".ignex/server.js"),
    },
  };
  console.log(JSON.stringify(report, null, 2));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const os = detectOs();
  const pm = detectPackageManager();

  if (args.includes("--check")) {
    printCheck(os, pm);
    return;
  }

  step(
    \`Detected \${os.family}\${os.distro ? \` (\${os.distro}\${os.version ? " " + os.version : ""})\` : ""} · package manager: \${pm ?? "none"}\`,
  );
  if (args.includes("--docker")) await dockerStage(os, pm);
  if (args.includes("--caddy")) await caddyStage(os, pm);

  envStage();
  await gitStage(pm);
  await depsStage();
  if (args.includes("--systemd")) await systemdStage();
  await buildStage();
  await smokeStage();

  step("Setup complete");
  info("bun run dev     # develop (watch + restart)");
  info("bun run build   # production artifact (.ignex/server.js)");
}

await main();
`;
}
