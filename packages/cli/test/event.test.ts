/**
 * Tests for the `ignex event` wizard templates — SSE streams, webhook
 * receivers, and the typed event bus, plus the runEvent command wiring.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runEvent } from "../src/commands/event.js";
import {
  eventBusConsumerTemplate,
  eventBusEmitRouteTemplate,
  eventBusLibTemplate,
  eventBusPluginTemplate,
  eventBusRealtimeTemplate,
  eventFiles,
  eventSseModuleTemplate,
  eventSseRouteTemplate,
  eventSummary,
  eventWebhookModuleTemplate,
  eventWebhookRouteTemplate,
  pascalFromKebab,
  validateEventName,
} from "../src/templates/event.js";

/** Create a throwaway project dir for one test. */
function tmpTarget(): string {
  return mkdtempSync(join(tmpdir(), "ignex-cli-event-"));
}

describe("validateEventName", () => {
  it("accepts kebab-case names", () => {
    expect(validateEventName("orders")).toBeUndefined();
    expect(validateEventName("order-created")).toBeUndefined();
    expect(validateEventName("a1-b2")).toBeUndefined();
  });

  it("rejects invalid names", () => {
    expect(validateEventName("Order")).toBeTruthy();
    expect(validateEventName("order_created")).toBeTruthy();
    expect(validateEventName("order.created")).toBeTruthy();
    expect(validateEventName("")).toBeTruthy();
    expect(validateEventName("orders/events")).toBeTruthy();
  });
});

describe("pascalFromKebab", () => {
  it("converts kebab-case to PascalCase", () => {
    expect(pascalFromKebab("order-created")).toBe("OrderCreated");
    expect(pascalFromKebab("orders")).toBe("Orders");
  });
});

describe("sse templates", () => {
  it("module streams SSEMessage events", () => {
    const code = eventSseModuleTemplate("orders");
    expect(code).toContain("streamOrders");
    expect(code).toContain("AsyncGenerator<SSEMessage>");
    expect(code).toContain('event: "orders.updated"');
  });

  it("route wraps the module generator with sse()", () => {
    const code = eventSseRouteTemplate("orders");
    expect(code).toContain('import { sse } from "@ignex/core";');
    expect(code).toContain('import { streamOrders } from "../../modules/events/orders.get.js";');
    expect(code).toContain("export default get(() => sse(streamOrders()));");
  });
});

describe("webhook templates", () => {
  it("module receives the payload", () => {
    const code = eventWebhookModuleTemplate("orders");
    expect(code).toContain("handleOrdersEvent(payload: unknown)");
    expect(code).toContain("POST /hooks/orders");
  });

  it("route reads the body and returns 202", () => {
    const code = eventWebhookRouteTemplate("orders");
    expect(code).toContain(
      'import { handleOrdersEvent } from "../../modules/hooks/orders.post.js";',
    );
    expect(code).toContain("const payload = await ctx.body.json();");
    expect(code).toContain("return ctx.json({ received: true }, { status: 202 });");
  });
});

describe("bus templates", () => {
  it("contract file declares the named event with a TypeBox payload", () => {
    const code = eventBusRealtimeTemplate("order");
    expect(code).toContain("export const realtime = {");
    expect(code).toContain('"order.created"');
    expect(code).toContain('subjectPrefix: "order"');
    expect(code).toContain('import { Type } from "@sinclair/typebox";');
  });

  it("plugin file pre-wires novaPlugin with events + generated bindings", () => {
    const code = eventBusPluginTemplate("order");
    expect(code).toContain("novaPlugin({");
    expect(code).toContain("events: {}");
    expect(code).toContain('import { bindings } from "../.ignex/sdk/realtime/index.js";');
    expect(code).toContain("authenticate(req)");
  });

  it("lib re-exports the typed server facade from the generated SDK", () => {
    const code = eventBusLibTemplate();
    expect(code).toContain('from "../../.ignex/sdk/realtime/server.js"');
    expect(code).toContain("emitToUser");
  });

  it("emit route publishes <name>.created through the typed facade", () => {
    const code = eventBusEmitRouteTemplate("order");
    expect(code).toContain('emit("order.created", payload);');
    expect(code).toContain('import { emit } from "../../lib/events.js";');
    expect(code).toContain("RealtimeEventPayloads");
  });

  it("consumer auto-registers: default-exports register() subscribing to the channel", () => {
    const code = eventBusConsumerTemplate("order");
    expect(code).toContain('on("order.created"');
    expect(code).toContain("export default function register(): void");
    expect(code).toContain('from "../../lib/events.js"');
    expect(code).toContain("src/realtime/consumers");
    expect(code).not.toContain("startOrderConsumers");
    expect(code).not.toContain("return off;");
  });
});

describe("eventFiles", () => {
  it("scaffolds sse module + route", () => {
    const files = eventFiles("sse", "orders");
    expect(files.map((f) => f.path)).toEqual([
      "modules/events/orders.get.ts",
      "routes/events/orders.get.ts",
    ]);
  });

  it("scaffolds webhook module + route", () => {
    const files = eventFiles("webhook", "orders");
    expect(files.map((f) => f.path)).toEqual([
      "modules/hooks/orders.post.ts",
      "routes/hooks/orders.post.ts",
    ]);
  });

  it("scaffolds bus contract + plugin + lib + emit route + auto-loaded consumer", () => {
    const files = eventFiles("bus", "order");
    expect(files.map((f) => f.path)).toEqual([
      "realtime.ts",
      "realtime.plugin.ts",
      "lib/events.ts",
      "routes/events/emit.order.post.ts",
      "realtime/consumers/order.consumer.ts",
    ]);
  });
});

describe("eventSummary", () => {
  it("describes each flow's endpoint", () => {
    expect(eventSummary("sse", "orders")).toContain("GET /events/orders");
    expect(eventSummary("webhook", "orders")).toContain("POST /hooks/orders");
    expect(eventSummary("bus", "order")).toContain("order.created");
  });
});

describe("ignex event (command wiring)", () => {
  it("scaffolds an SSE flow non-interactively", async () => {
    const dir = tmpTarget();
    try {
      await runEvent(["sse", "orders", "--root", dir]);

      const moduleFile = join(dir, "src/modules/events/orders.get.ts");
      const routeFile = join(dir, "src/routes/events/orders.get.ts");
      expect(existsSync(moduleFile)).toBe(true);
      expect(existsSync(routeFile)).toBe(true);
      expect(readFileSync(routeFile, "utf8")).toContain("sse(streamOrders())");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scaffolds a webhook receiver non-interactively", async () => {
    const dir = tmpTarget();
    try {
      await runEvent(["--kind", "webhook", "--name", "orders", "--root", dir]);

      expect(existsSync(join(dir, "src/routes/hooks/orders.post.ts"))).toBe(true);
      expect(existsSync(join(dir, "src/modules/hooks/orders.post.ts"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scaffolds the event bus + emit route + auto-loaded consumer", async () => {
    const dir = tmpTarget();
    try {
      await runEvent(["bus", "order", "--root", dir]);

      expect(existsSync(join(dir, "src/lib/events.ts"))).toBe(true);
      expect(existsSync(join(dir, "src/routes/events/emit.order.post.ts"))).toBe(true);
      const consumerPath = join(dir, "src/realtime/consumers/order.consumer.ts");
      expect(existsSync(consumerPath)).toBe(true);
      const consumer = readFileSync(consumerPath, "utf8");
      expect(consumer).toContain("export default function register(): void");
      expect(existsSync(join(dir, "src/modules/events/order.consumer.ts"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an invalid event name", async () => {
    const dir = tmpTarget();
    const originalExitCode = process.exitCode;
    try {
      await runEvent(["sse", "Order", "--root", dir]);
      expect(process.exitCode).toBe(1);
      expect(existsSync(join(dir, "src/routes/events/Order.get.ts"))).toBe(false);
    } finally {
      process.exitCode = originalExitCode;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown kind", async () => {
    const dir = tmpTarget();
    const originalExitCode = process.exitCode;
    try {
      await runEvent(["kafka", "orders", "--root", dir]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
