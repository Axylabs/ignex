export function indexRouteTemplate(name: string): string {
  const safe = name.replace(/"/g, '\\"');

  // Either export style is discovered by the compiler:
  //   export default get(() => ...)
  //   export const httpGet = get(() => ...)
  return `import { get } from "@ignex/core/http";

export const httpGet = get((ctx) => ctx.json({ name: "${safe}" }));
`;
}

export function healthRouteTemplate(): string {
  return `import { get } from "@ignex/core/http";

export const httpGet = get((ctx) => ctx.text("ok"));
`;
}

export function openApiRouteTemplate(name: string): string {
  const safe = name.replace(/"/g, '\\"');

  return `import { get } from "@ignex/core/http";
import { generateOpenAPI } from "@ignex/core";

export default get((ctx) =>
  ctx.json(
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
  return `import { get } from "@ignex/core/http";

export default get((ctx) => {
  const id = ctx.params.id;

  return ctx.json({ id });
});
`;
}

export function productAddRouteTemplate(): string {
  return `import { post } from "@ignex/core/http";

export default post(async (ctx) => {
  const body = await ctx.body.json();

  return ctx.json({ created: true, body }, { status: 201 });
});
`;
}

export function uploadRouteTemplate(): string {
  return `import { post } from "@ignex/core/http";

export default post(async (ctx) => {
  const form = await ctx.body.formData();
  const file = form.get("file");

  return ctx.json(
    {
      uploaded: file instanceof File ? file.name : null
    },
    { status: 201 }
  );
});
`;
}

export function sseRouteTemplate(): string {
  return `import { get } from "@ignex/core/http";
import { sse } from "@ignex/core";

export default get(() =>
  sse(async function* () {
    yield { event: "ping", data: Date.now().toString() };
  })
);
`;
}

export function cacheRouteTemplate(): string {
  return `import { get } from "@ignex/core/http";
import { withBrowserCache } from "@ignex/core";

export default get(() =>
  withBrowserCache(ctx.json({ cached: true }), { maxAge: 10 })
);
`;
}

export function proxyRouteTemplate(): string {
  return `import { get } from "@ignex/core/http";
import { proxyRequest } from "@ignex/core";

export default get(() => proxyRequest("https://example.com"));
`;
}

export function wsExampleTemplate(): string {
  return `import { createWSHandler } from "@ignex/core";

export const wsHandler = createWSHandler({
  open(ws) {
    ws.send("Welcome to Ignex");
  },
  message(ws, message) {
    ws.send(String(message));
  }
});
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

// ============================================================================
// New framework feature templates
// ============================================================================

export function requireAuthHookTemplate(): string {
  return `import { continueHook, haltHook, jwtVerify } from "@ignex/core";

// Shared auth hook: verifies an HS256 Bearer token and attaches the claims to
// \`ctx.state.user\`. Used via \`export const config = { hooks: ["require-auth"] }\`.
export default (async (ctx) => {
  const header = ctx.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

  const claims = token
    ? jwtVerify(token, process.env.JWT_SECRET ?? "dev-secret-change-me")
    : null;

  if (!claims) {
    return haltHook(ctx.json({ error: "Unauthorized" }, { status: 401 }));
  }

  ctx.setState("user", claims);
  return continueHook(ctx);
});
`;
}

export function loginRouteTemplate(): string {
  return `import { post } from "@ignex/core/http";
import { createJwt } from "@ignex/core";

const jwt = createJwt({
  secret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  ttlSeconds: 3600,
  issuer: "ignex-app"
});

const USERS: Record<string, string> = { admin: "secret" };

export default post(async (ctx) => {
  const body = await ctx.body.json<{ username?: string; password?: string }>();

  if (!body.username || USERS[body.username] !== body.password) {
    return ctx.json({ error: "Invalid credentials" }, { status: 401 });
  }

  return ctx.json({ token: jwt.sign({ sub: body.username, role: "admin" }) });
});
`;
}

export function meRouteTemplate(): string {
  return `import { get } from "@ignex/core/http";

export const config = { hooks: ["require-auth"] };

export default get((ctx) => ctx.json({ user: ctx.getState("user") ?? null }));
`;
}

export function sessionRouteTemplate(): string {
  return `import { get } from "@ignex/core/http";
import { getSession } from "@ignex/core";

export default get(async (ctx) => {
  const session = getSession(ctx);
  if (!session) return ctx.json({ session: null });

  const visits = ((session.data.visits as number | undefined) ?? 0) + 1;
  session.data.visits = visits;
  await session.save();

  return ctx.json({ id: session.id, visits, isNew: session.isNew });
});
`;
}

export function pageRouteTemplate(): string {
  return `import { get } from "@ignex/core/http";
import { createTemplateDir, withLayout } from "@ignex/core";
import { join } from "node:path";

export default get(async (ctx) => {
  const registry = await createTemplateDir(join(process.cwd(), "src/views"));

  const page = withLayout((content, data) =>
    registry.render("layout", { ...data, content })
  )((data) => registry.render("home", data));

  return ctx.html(
    page({
      title: "Ignex app",
      name: ctx.query.get("name") ?? "world",
      features: ["routing", "templates", "i18n", "native"]
    })
  );
});
`;
}

export function i18nRouteTemplate(): string {
  return `import { get } from "@ignex/core/http";
import { createI18n } from "@ignex/core";

const i18n = createI18n(
  {
    en: { greeting: "Hello {name}" },
    es: { greeting: "Hola {name}" },
    fr: { greeting: "Bonjour {name}" }
  },
  { fallbackLocale: "en" }
);

export default get((ctx) => {
  const locale = i18n.locale(ctx);
  return ctx.json({
    locale,
    message: i18n.t("greeting", { name: ctx.query.get("name") ?? "world" }, locale)
  });
});
`;
}

export function envRouteTemplate(): string {
  return `import { get } from "@ignex/core/http";
import { defineConfig, env, loadEnv } from "@ignex/core";

loadEnv();

const config = defineConfig({
  PORT: { type: "number", default: 3000 },
  NODE_ENV: { type: "string", default: "development" },
  DEBUG: { type: "boolean", default: false }
});

export default get((ctx) =>
  ctx.json({ nodeEnv: config.NODE_ENV, port: config.PORT, debug: config.DEBUG, direct: env("SOME_VAR", "fallback") })
);
`;
}

export function jobsRouteTemplate(): string {
  return `import { get } from "@ignex/core/http";
import { createJobQueue, withRetry, withTimeout } from "@ignex/core";

const queue = createJobQueue({ concurrency: 2 });

const task = withTimeout(5000)(
  withRetry(2)(async () => {
    // do work
  })
);

export default get((ctx) => {
  queue.enqueue("demo", task);
  return ctx.json({ enqueued: true, pending: queue.pending, running: queue.running });
});
`;
}

export function layoutTemplate(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{{ title }}</title>
  </head>
  <body>
    <main>{{ content }}</main>
  </body>
</html>
`;
}

export function homeTemplate(): string {
  return `<h1>Hello {{ name }}!</h1>
<ul>
  {% for feature in features %}
  <li>{{ feature | upper }}</li>
  {% endfor %}
</ul>
`;
}

export function appConfigTemplate(): string {
  return `import { compression, cors, security, session } from "@ignex/core";

export const plugins = [
  cors(),
  compression(),
  security(),
  session({ secret: process.env.SESSION_SECRET ?? "dev-secret-change-me", createIfMissing: true })
];

export const server = {
  port: Number(process.env.PORT ?? 3000)
};
`;
}
