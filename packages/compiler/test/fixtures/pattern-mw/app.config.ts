// Pattern-scoped global middleware fixture: the plugin only runs for /api/*.
import type { IgnexPlugin } from "@ignex/core";

export const plugins: IgnexPlugin[] = [
  {
    name: "api-scope",
    pattern: "/api/*",
    onRequest(ctx) {
      ctx.setState("scoped", true);
      return ctx;
    },
    onResponse(_ctx, response) {
      const headers = new Headers(response.headers);
      headers.set("x-scoped", "yes");
      return new Response(response.body, { status: response.status, headers });
    },
  },
];

export const server = { https: false };
