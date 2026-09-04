/**
 * Serve-boot origin tests — the scheme-correct origin used by plugin boot logs.
 *
 * Covers the broadcast channel (`setServeBootInfo` → `getServeBootInfo`) and
 * `bootOrigin`: resolved protocol wins, bind addresses (`0.0.0.0` / `::`)
 * display as `localhost`, and the pre-boot env heuristics remain the fallback.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootOrigin,
  getServeBootInfo,
  type ServeBootInfo,
  setServeBootInfo,
} from "../src/http/serve-boot";

describe("serve boot info broadcast", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    // Restore a neutral published value so later cases in this file stay deterministic.
    setServeBootInfo({ protocol: "https", port: 3000 });
  });

  it("publishes and reads back the resolved serve values", () => {
    const info: ServeBootInfo = { protocol: "http", port: 8080, hostname: "127.0.0.1" };
    setServeBootInfo(info);
    expect(getServeBootInfo()).toEqual(info);
  });

  it("builds an http origin when the server resolved plain HTTP", () => {
    setServeBootInfo({ protocol: "http", port: 3000, hostname: "0.0.0.0" });
    expect(bootOrigin()).toBe("http://localhost:3000");
  });

  it("builds an https origin with an explicit hostname when TLS is on", () => {
    setServeBootInfo({ protocol: "https", port: 8443, hostname: "api.example.com" });
    expect(bootOrigin()).toBe("https://api.example.com:8443");
  });

  it("falls back to env heuristics before a server publishes boot info", async () => {
    vi.resetModules();
    vi.stubEnv("PORT", "4123");
    // `NODE_ENV=development` historically guessed https outside a server; the
    // fallback must still produce the env-derived origin.
    const fresh = (await import(
      "../src/http/serve-boot"
    )) as typeof import("../src/http/serve-boot");
    expect(fresh.bootOrigin()).toBe("https://localhost:4123");
  });
});
