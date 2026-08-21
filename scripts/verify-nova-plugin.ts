/**
 * Verify the `novaPlugin` end-to-end against the REAL `@ignex/nova` package
 * under plain Bun — where `bun:ffi` is available (vitest workers do not expose
 * it, so the unit tests in `packages/core/test/nova-plugin.test.ts` inject a
 * fake loader instead).
 *
 * Boots a `createApp` with `novaPlugin`, opens a real WebSocket client, sends a
 * typed event, and asserts the server receives it and can target a reply.
 * Exits 0 on success, 1 on any failure.
 *
 * Usage:
 *   bun scripts/verify-nova-plugin.ts
 */
import { createApp, novaAuthFromHook, novaPlugin } from "@ignex/core";

const PORT = 4012;

const app = createApp({
  plugins: [
    novaPlugin({
      port: PORT,
      path: "/ws",
      inbound: ["chat"],
      // Simple test identity: any request carrying ?token=t1 passes as u-1.
      authenticate: novaAuthFromHook((async (ctx: {
        req?: Request;
        state?: Record<string, unknown>;
      }) => {
        const url = ctx.req?.url ?? "";
        if (new URL(url).searchParams.get("token") === "t1") {
          ctx.state = {
            user: { sub: "u-1", groups: ["testers"] },
          };
        }
        return undefined;
      }) as never),
    }),
  ],
  handler: () => new Response("ok"),
});

const fail = (message: string): never => {
  console.error("FAIL:", message);
  process.exit(1);
};

try {
  await app.init();
  console.log(`[verify-nova] nova server up on ws://localhost:${PORT}/ws`);

  // Connect with a bearer token in the query so the auth bridge maps the
  // claims to a client (nova's authenticate receives the upgrade Request).
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=t1`);

  const opened = await new Promise<boolean>((resolve) => {
    ws.onopen = () => resolve(true);
    ws.onerror = () => resolve(false);
    setTimeout(() => resolve(false), 3000);
  });
  if (!opened) fail("client did not connect");

  // The built-in registry's `chat` event is inbound-allowed; echo a message.
  const reply = new Promise<string>((resolve) => {
    ws.onmessage = (e) => resolve(typeof e.data === "string" ? e.data : String(e.data));
    setTimeout(() => resolve("__timeout__"), 3000);
  });
  ws.send(
    JSON.stringify({ event: "chat", payload: { room: "lobby", text: "hi", ts: Date.now() } }),
  );

  const data = await reply;
  if (data === "__timeout__") fail("no reply received (server did not process the typed frame)");

  console.log("[verify-nova] received reply:", data.slice(0, 80));
  ws.close();

  await app.stop({ stopDeadlineMs: 2000 });
  console.log("[verify-nova] OK — real @ignex/nova integration verified.");
  process.exit(0);
} catch (error) {
  console.error("[verify-nova] error:", error);
  try {
    await app.stop({ stopDeadlineMs: 1000 });
  } catch {
    // best-effort cleanup
  }
  process.exit(1);
}
