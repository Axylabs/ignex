/**
 * Realtime SDK platform tests — artifact loading (`realtime.json` +
 * `rpc-manifest.json` → `ctx.realtime`) and full nova wire-stack emission
 * (guarded by the `flatc` prerequisite, like the codegen itself).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generateSdk, loadSdkInputs, sdkPlatforms } from "../src";

/** Whether the nova codegen prerequisite is available on this machine. */
const flatcAvailable = spawnSync("flatc", ["--version"], { stdio: "ignore" }).status === 0;

/** Minimal compiled-artifact fixture (manifest.json + openapi.json). */
const FIXTURE_ARTIFACTS = {
  "manifest.json": JSON.stringify({
    serviceName: "petshop",
    routes: [{ method: "GET", path: "/health", responseType: "json" }],
  }),
  "openapi.json": JSON.stringify({
    openapi: "3.1.0",
    info: { title: "petshop", version: "1.0.0" },
    paths: {
      "/health": {
        get: {
          responses: {
            "200": { content: { "application/json": { schema: { type: "object" } } } },
          },
        },
      },
    },
  }),
};

/** Realtime declarations fixture (TypeBox-JSON schemas). */
const FIXTURE_REALTIME = {
  subjectPrefix: "safo",
  schemas: {
    ChatMessage: {
      type: "object",
      properties: { id: { type: "string" }, body: { type: "string" } },
      required: ["id", "body"],
      additionalProperties: false,
    },
  },
  events: {
    "chat.send": {
      type: "object",
      properties: { orderId: { type: "string" }, body: { type: "string" } },
      required: ["orderId", "body"],
      additionalProperties: false,
    },
    "chat.message": {
      type: "object",
      properties: {
        id: { type: "string" },
        body: { type: "string" },
        at: { type: "integer" },
      },
      required: ["id", "body", "at"],
      additionalProperties: false,
    },
  },
  controlEvents: {},
};

/** RPC manifest fixture (runtime RPC kit artifact). */
const FIXTURE_RPC_MANIFEST = {
  methods: {
    "me.get": {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
};

const tmpDirs: string[] = [];
const tmpArtifacts = (extra: Record<string, string> = {}): string => {
  const dir = mkdtempSync(join(process.cwd(), ".sdk-rt-test-"));
  tmpDirs.push(dir);
  for (const [file, content] of Object.entries({ ...FIXTURE_ARTIFACTS, ...extra })) {
    writeFileSync(join(dir, file), content);
  }
  return dir;
};

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("realtime input loading", () => {
  it("populates ctx.realtime from realtime.json + rpc-manifest.json", () => {
    const outDir = tmpArtifacts({
      "realtime.json": JSON.stringify(FIXTURE_REALTIME),
      "rpc-manifest.json": JSON.stringify(FIXTURE_RPC_MANIFEST),
    });
    const inputs = loadSdkInputs(outDir);
    expect(inputs.realtime).toBeDefined();
    expect(inputs.realtime?.subjectPrefix).toBe("safo");
    expect(Object.keys(inputs.realtime?.events ?? {}).sort()).toEqual([
      "chat.message",
      "chat.send",
    ]);
    expect(inputs.realtime?.schemas).toEqual(FIXTURE_REALTIME.schemas);
    expect(inputs.realtime?.controlEvents).toEqual({});
    expect(inputs.realtime?.rpcMethods).toEqual(FIXTURE_RPC_MANIFEST.methods);
  });

  it("omits rpcMethods when rpc-manifest.json is absent", () => {
    const outDir = tmpArtifacts({ "realtime.json": JSON.stringify(FIXTURE_REALTIME) });
    const inputs = loadSdkInputs(outDir);
    expect(inputs.realtime).toBeDefined();
    expect(inputs.realtime?.rpcMethods).toBeUndefined();
  });

  it("omits realtime entirely when neither artifact exists", () => {
    const inputs = loadSdkInputs(tmpArtifacts());
    expect(inputs.realtime).toBeUndefined();
  });

  it("throws a clear error on malformed realtime.json", () => {
    const outDir = tmpArtifacts({ "realtime.json": "{not json" });
    expect(() => loadSdkInputs(outDir)).toThrow(/realtime\.json.*not valid JSON/s);

    const badShape = tmpArtifacts({ "realtime.json": JSON.stringify({ events: [] }) });
    expect(() => loadSdkInputs(badShape)).toThrow(/subjectPrefix/);
  });

  it("throws a clear error on malformed rpc-manifest.json", () => {
    const outDir = tmpArtifacts({
      "realtime.json": JSON.stringify(FIXTURE_REALTIME),
      "rpc-manifest.json": JSON.stringify({ methods: "nope" }),
    });
    expect(() => loadSdkInputs(outDir)).toThrow(/rpc-manifest\.json.*"methods"/s);
  });
});

describe("realtime platform", () => {
  it("is registered in the platform registry", () => {
    expect(sdkPlatforms.realtime).toBeDefined();
    expect(sdkPlatforms.realtime.id).toBe("realtime");
  });

  it("explains how to produce realtime input when there is none", async () => {
    const outDir = tmpArtifacts();
    await expect(generateSdk({ outDir, platforms: ["realtime"] })).rejects.toThrow(
      /ignex build.*realtime\.ts[\s\S]*realtime\.json/s,
    );
  });

  it.skipIf(!flatcAvailable)(
    "emits the full realtime package from compiled artifacts",
    async () => {
      const outDir = tmpArtifacts({
        "realtime.json": JSON.stringify(FIXTURE_REALTIME),
        "rpc-manifest.json": JSON.stringify(FIXTURE_RPC_MANIFEST),
      });
      const result = await generateSdk({
        outDir,
        packageDir: join(outDir, "out"),
        name: "@acme/petshop-realtime-sdk",
        version: "2.0.0",
        platforms: ["realtime"],
      });
      expect(result.packages).toHaveLength(1);
      const pkg = result.packages[0];
      if (pkg === undefined) throw new Error("no package");
      expect(pkg.platform).toBe("realtime");

      const files = new Map(pkg.files.map((f) => [f.path, f.content]));
      const paths = [...files.keys()];

      // Framework-owned modules.
      for (const expected of [
        "package.json",
        "README.md",
        "realtime/index.ts",
        "realtime/schema.ts",
        "realtime/payloads.gen.ts",
        "realtime/client.gen.ts",
        "realtime/server.ts",
        "realtime/rpc.gen.ts",
      ]) {
        expect(paths).toContain(expected);
      }
      // Generated nova wire stack (entry renamed to wire.ts).
      for (const expected of [
        "realtime/wire.ts",
        "realtime/registry.ts",
        "realtime/backend.fbs",
        "realtime/wire-registry.json",
      ]) {
        expect(paths).toContain(expected);
      }
      // flatc TS decoders.
      expect(paths.some((p) => p.startsWith("realtime/ts/"))).toBe(true);
      // Rust glue and the generated README are dropped; entry not duplicated.
      expect(paths.some((p) => p.startsWith("rust/"))).toBe(false);
      expect(paths.filter((p) => p === "realtime/wire.ts")).toHaveLength(1);

      // Payload types come from the fixture schemas (not generic derivation).
      const payloads = files.get("realtime/payloads.gen.ts") ?? "";
      expect(payloads).toContain('"chat.send": {');
      expect(payloads).toContain("orderId: string;");
      expect(payloads).toContain('"me.get": {');

      // Schema consts carry the serialized registries.
      const schema = files.get("realtime/schema.ts") ?? "";
      expect(schema).toContain('"chat.send"');
      expect(schema).toContain("as Record<string, TSchema>");

      // Typed client + RPC facade over @ignex/nova.
      const client = files.get("realtime/client.gen.ts") ?? "";
      expect(client).toContain("@ignex/nova/client");
      expect(client).toContain("makeBindings({ events, controlEvents } as never)");
      expect(client).toContain("export interface TypedRealtimeClient");
      expect(client).toContain(
        "export type RealtimeEventName = keyof RealtimeEventPayloads & string",
      );
      const rpc = files.get("realtime/rpc.gen.ts") ?? "";
      expect(rpc).toContain("export class RpcError extends Error");
      expect(rpc).toContain('send("rpc.request", { id, method, payload: JSON.stringify(args) })');
      expect(rpc).toContain("20_000");
      expect(rpc).toContain("keyof RpcMethodArgs & string");

      // Barrel re-exports the framework-owned modules (+ the wire stack) but
      // NOT the server-only facade — the root stays browser-safe. Re-exporting
      // ./server would drag @ignex/nova/events (and its node:module/ioredis
      // loader) into browser bundles, crashing with "createRequire is not a
      // function". Server code imports the facade from the ./server subpath.
      const index = files.get("realtime/index.ts") ?? "";
      expect(index).toContain('from "./schema"');
      expect(index).toContain('from "./payloads.gen"');
      expect(index).toContain('from "./client.gen"');
      expect(index).toContain('from "./rpc.gen"');
      expect(index).not.toContain('from "./server"');

      // Typed server-side facade: emit/on/emitToUser typed against app events.
      const server = files.get("realtime/server.ts") ?? "";
      expect(server).toContain('from "@ignex/nova/events"');
      expect(server).toContain(
        "export type RealtimeEventName = keyof RealtimeEventPayloads & string",
      );
      expect(server).toContain("export const emitToUser = <K extends RealtimeEventName>(");
      expect(server).toContain("export const on = <K extends RealtimeEventName>(");
      expect(server).toContain("_emit(name as never, payload as never)");
      // Handler ctx is typed (not `unknown`) so `ctx.client`/`ctx.source` give
      // the sender's identity — attribution is a first-class, type-safe part
      // of the facade. Context/client/source types are re-exported for typing.
      expect(server).toContain(
        'import type { EventClient, EventContext, EventSource } from "@ignex/nova/events"',
      );
      expect(server).toContain("export type RealtimeEventContext = EventContext;");
      expect(server).toContain("export type RealtimeEventHandler<K extends RealtimeEventName> =");
      expect(server).toContain("ctx: RealtimeEventContext");
      expect(server).not.toContain("ctx: unknown");
      // Full-mesh cross-service user emit is part of the facade.
      expect(server).toContain("export const emitToUserAnywhere = <K extends RealtimeEventName>(");
      expect(server).toContain("_emitToUserAnywhere(userId, name as never, payload as never)");

      // package.json: naming + subpath exports + pinned deps.
      const pkgJson = JSON.parse(files.get("package.json") ?? "{}") as {
        name: string;
        version: string;
        exports: Record<string, string>;
        dependencies: Record<string, string>;
      };
      expect(pkgJson.name).toBe("@acme/petshop-realtime-sdk");
      expect(pkgJson.version).toBe("2.0.0");
      expect(pkgJson.exports["."]).toBe("./realtime/index.ts");
      expect(pkgJson.exports["./client"]).toBe("./realtime/client.gen.ts");
      expect(pkgJson.exports["./server"]).toBe("./realtime/server.ts");
      expect(pkgJson.exports["./rpc"]).toBe("./realtime/rpc.gen.ts");
      expect(pkgJson.dependencies["@ignex/nova"]).toBe("^0.1.7");
      expect(pkgJson.dependencies["@sinclair/typebox"]).toBe("^0.34.0");
    },
  );

  it.skipIf(!flatcAvailable)("is deterministic across runs", async () => {
    const extra = {
      "realtime.json": JSON.stringify(FIXTURE_REALTIME),
      "rpc-manifest.json": JSON.stringify(FIXTURE_RPC_MANIFEST),
    };
    const options = {
      outDir: tmpArtifacts(extra),
      packageDir: join(tmpArtifacts(extra), "out"),
      name: "@acme/petshop-realtime-sdk",
      version: "2.0.0",
      platforms: ["realtime"] as const,
    };
    const a = await generateSdk(options);
    const b = await generateSdk(options);
    const dump = (result: typeof a): string =>
      result.packages[0].files
        .map((f) => `${f.path}\n${f.content}`)
        .sort()
        .join("\n---\n");
    expect(dump(b)).toBe(dump(a));
  });
});
