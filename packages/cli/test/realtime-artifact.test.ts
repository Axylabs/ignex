/**
 * `emitRealtimeArtifact` tests — the `<root>/src/realtime.ts` →
 * `<outDir>/realtime.json` artifact contract (validation, defaults,
 * atomic write, and the no-op path when the app has no realtime module).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { emitRealtimeArtifact } from "../src/utils/realtime-artifact.js";

const dirs: string[] = [];
const tmpRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ignex-cli-rt-"));
  dirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("emitRealtimeArtifact", () => {
  it("returns false when src/realtime.ts is absent", async () => {
    const root = tmpRoot();
    const outDir = join(root, ".ignex");
    expect(await emitRealtimeArtifact(root, outDir)).toBe(false);
    expect(existsSync(join(outDir, "realtime.json"))).toBe(false);
  });

  it("writes realtime.json with subjectPrefix defaulted from package.json (scope stripped)", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@safo/backend" }));
    writeFileSync(
      join(root, "src", "realtime.ts"),
      `export const realtime = { events: { "chat.send": { type: "object" } } };`,
    );
    const outDir = join(root, ".ignex");
    expect(await emitRealtimeArtifact(root, outDir)).toBe(true);
    const artifact = JSON.parse(readFileSync(join(outDir, "realtime.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(artifact.subjectPrefix).toBe("backend");
    expect(artifact.events).toEqual({ "chat.send": { type: "object" } });
  });

  it("honors an explicit subjectPrefix and passes schemas/controlEvents through", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "realtime.ts"),
      `export const realtime = {
        subjectPrefix: "safo",
        schemas: { ChatMessage: { type: "object" } },
        events: { "chat.message": { type: "object" } },
        controlEvents: {},
      };`,
    );
    const outDir = join(root, "custom-out");
    expect(await emitRealtimeArtifact(root, outDir)).toBe(true);
    const artifact = JSON.parse(readFileSync(join(outDir, "realtime.json"), "utf8")) as {
      subjectPrefix: string;
      events: Record<string, unknown>;
      controlEvents: Record<string, unknown>;
      schemas: Record<string, unknown>;
    };
    expect(artifact.subjectPrefix).toBe("safo");
    expect(artifact.schemas).toEqual({ ChatMessage: { type: "object" } });
    expect(artifact.controlEvents).toEqual({});
  });

  it("falls back to ignex when no package name exists", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "realtime.ts"),
      `export const realtime = { events: { ping: { type: "object" } } };`,
    );
    await emitRealtimeArtifact(root, join(root, ".ignex"));
    const artifact = JSON.parse(readFileSync(join(root, ".ignex", "realtime.json"), "utf8")) as {
      subjectPrefix: string;
    };
    expect(artifact.subjectPrefix).toBe("ignex");
  });

  it("throws when the realtime export is missing or has empty events", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "realtime.ts"), `export const other = {};`);
    await expect(emitRealtimeArtifact(root, join(root, ".ignex"))).rejects.toThrow(
      /must export a `realtime` object/,
    );

    writeFileSync(join(root, "src", "realtime.ts"), `export const realtime = { events: {} };`);
    await expect(emitRealtimeArtifact(root, join(root, ".ignex"))).rejects.toThrow(
      /non-empty record/,
    );
  });
});
