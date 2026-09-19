/** State snapshots must not collect/render the full KT document. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, createRouter } from "../src/index";
import { debugbar } from "../src/plugins/debugbar";

vi.mock("../src/debug/kt", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/debug/kt")>();
  return {
    ...original,
    buildAppKnowledge: vi.fn(() => {
      throw new Error("State must not build KT knowledge");
    }),
  };
});
afterEach(() => vi.unstubAllGlobals());

describe("lightweight state snapshot", () => {
  it.each([false, true])("serves state without KT (router: %s)", async (withRouter) => {
    const router = createRouter().get("/hello", () => new Response("hello"));
    const app = createApp({
      ...(withRouter ? { router } : { handler: () => new Response("hello") }),
      plugins: [debugbar({ enabled: true, persist: false, serviceName: "light-state" })],
    });
    const response = await app.handler(new Request("http://x/__debugbar/api/state"));
    expect(response.status).toBe(200);
    const snapshot = await response.json();
    expect(snapshot.service).toBe("light-state");
    expect(snapshot.plugins).toContain("debugbar");
    expect(snapshot.routes).toBeGreaterThanOrEqual(withRouter ? 1 : 0);
  });
});
