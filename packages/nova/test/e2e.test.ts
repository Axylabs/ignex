/**
 * Full-stack demo test: boots `src/server.ts` (page + ws), verifies the static
 * page and client bundle are served, and that typed events stream over the ws.
 */
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { WIRE_HEADER_LEN, WIRE_VERSION } from "../src/generated/registry";

describe("demo server (src/server.ts)", () => {
  test("serves page + bundle and streams typed events", async () => {
    const port = 3100 + Math.floor(Math.random() * 400);
    const child = spawn("bun", ["run", "src/server.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout?.on("data", (d) => (logs += String(d)));

    try {
      let healthy = false;
      for (let i = 0; i < 60; i++) {
        try {
          if ((await fetch(`http://localhost:${port}/health`)).status === 200) {
            healthy = true;
            break;
          }
        } catch {
          // not up yet
        }
        await Bun.sleep(100);
      }
      expect(healthy).toBe(true);

      const page = await fetch(`http://localhost:${port}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("ignex-nova");

      const bundle = await fetch(`http://localhost:${port}/dist/main.js`);
      expect(bundle.status).toBe(200);

      // receive at least one typed event frame within ~5s (server publishes every 1s)
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      ws.binaryType = "arraybuffer";
      const got = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 5000);
        ws.onmessage = (ev) => {
          clearTimeout(timer);
          const bytes = new Uint8Array(ev.data as ArrayBuffer);
          resolve(bytes.length > WIRE_HEADER_LEN && bytes[0] === WIRE_VERSION); // valid envelope
        };
      });
      expect(await got).toBe(true);
      ws.close();
    } finally {
      child.kill("SIGTERM");
    }
  }, 15000);
});
