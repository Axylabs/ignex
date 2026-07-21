export function indexRouteTemplate(name: string): string {
  const safe = name.replace(/"/g, '\\"');

  return `import { get } from "@flux/core/http";

export default get(() => Response.json({ name: "${safe}" }));
`;
}

export function healthRouteTemplate(): string {
  return `import { get } from "@flux/core/http";

export default get(() => new Response("ok"));
`;
}

export function openApiRouteTemplate(name: string): string {
  const safe = name.replace(/"/g, '\\"');

  return `import { get } from "@flux/core/http";
import { generateOpenAPI } from "@flux/core";

export default get(() =>
  Response.json(
    generateOpenAPI(
      {
        title: "${safe}",
        version: "0.1.0"
      },
      []
    )
  )
);
`;
}

export function productByIdRouteTemplate(): string {
  return `import { get } from "@flux/core/http";

export default get((ctx) => {
  const id = ctx.params.id;

  return Response.json({ id });
});
`;
}

export function productAddRouteTemplate(): string {
  return `import { post } from "@flux/core/http";

export default post(async (ctx) => {
  const body = await ctx.body.json();

  return Response.json({ created: true, body }, { status: 201 });
});
`;
}

export function uploadRouteTemplate(): string {
  return `import { post } from "@flux/core/http";

export default post(async (ctx) => {
  const form = await ctx.body.formData();
  const file = form.get("file");

  return Response.json(
    {
      uploaded: file instanceof File ? file.name : null
    },
    { status: 201 }
  );
});
`;
}

export function sseRouteTemplate(): string {
  return `import { get } from "@flux/core/http";
import { sse } from "@flux/core";

export default get(() =>
  sse(async function* () {
    yield { event: "ping", data: Date.now().toString() };
  })
);
`;
}

export function cacheRouteTemplate(): string {
  return `import { get } from "@flux/core/http";
import { withBrowserCache } from "@flux/core";

export default get(() =>
  withBrowserCache(Response.json({ cached: true }), { maxAge: 10 })
);
`;
}

export function proxyRouteTemplate(): string {
  return `import { get } from "@flux/core/http";
import { proxyRequest } from "@flux/core";

export default get(() => proxyRequest("https://example.com"));
`;
}

export function wsExampleTemplate(): string {
  return `import { createWSHandler } from "@flux/core";

export const wsHandler = createWSHandler({
  open(ws) {
    ws.send("Welcome to Flux");
  },
  message(ws, message) {
    ws.send(String(message));
  }
});
`;
}

export function clusterExampleTemplate(): string {
  return `import { serveCluster } from "@flux/core";

// Example multi-core entry.
// Adjust once your generated server entry/runtime options are finalized.
//
// serveCluster({
//   port: Number(process.env.PORT ?? 3000)
// });

export {};
`;
}

export function vitestConfigTemplate(): string {
  return `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"]
  }
});
`;
}

export function testTemplate(): string {
  return `import { expect, test } from "vitest";

test("placeholder", () => {
  expect(true).toBe(true);
});
`;
}