/**
 * @fileoverview CLI route template generators — route modules emitted into scaffolded apps.
 */
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
  sse(
    (async function* () {
      yield { event: "ping", data: Date.now().toString() };
    })(),
  ),
);
`;
}

export function cacheRouteTemplate(): string {
  return `import { get } from "@ignex/core/http";
import { withBrowserCache } from "@ignex/core";

export default get((ctx) =>
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

export function testTemplate(name: string, runtime: "bun" | "node" = "bun"): string {
  const safeName = name.replace(/"/g, '\\"');
  const runner = runtime === "node" ? "node" : "bun";
  return `import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Boot smoke test: AOT-compile (if needed), start the compiled server, and
// assert the core routes respond. Requires MongoDB when the app uses the ninox
// resource wiring (src/db.ts connects at boot).
const root = process.cwd();
const serverPath = join(root, ".ignex", "server.js");
const port = 3999;
const baseUrl = "http://127.0.0.1:" + port;

async function ensureBuilt(): Promise<void> {
  if (existsSync(serverPath)) return;
  const { execSync } = await import("node:child_process");
  execSync("bun run build", { cwd: root, stdio: "inherit" });
}

async function waitForReady(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl + "/health");
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not become ready in time");
}

let server: ChildProcess | null = null;

beforeAll(async () => {
  await ensureBuilt();
  server = spawn("${runner}", [serverPath], {
    env: { ...process.env, PORT: String(port), IGNEX_HTTPS: "0" },
    stdio: "ignore",
  });
  await waitForReady();
}, 30000);

afterAll(() => {
  server?.kill();
});

test("GET /health responds ok", async () => {
  const res = await fetch(baseUrl + "/health");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

test("GET / returns the app name", async () => {
  const res = await fetch(baseUrl + "/");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { name?: string };
  expect(body.name).toBe("${safeName}");
});
`;
}

// ============================================================================
// New framework feature templates
// ============================================================================

export function requireAuthHookTemplate(): string {
  return `import { requireAuth } from "../lib/auth.js";

// Shared auth hook: verifies a Bearer token with the app's auth module
// (Ed25519 JWT) and attaches the claims to \`ctx.state\`. Used via
// \`export const config = { hooks: ["require-auth"] }\`.
export default requireAuth;
`;
}

export { authLibTemplate } from "./auth.js";

export function loginRouteTemplate(options: { refresh: boolean }): string {
  const { refresh } = options;
  const libImports = refresh
    ? `import { ACCESS_TTL_SECONDS, auth, refreshTokens, userStore } from "../../lib/auth.js";`
    : `import { ACCESS_TTL_SECONDS, auth, userStore } from "../../lib/auth.js";`;
  const issueRefresh = refresh
    ? `
  const refreshToken = await refreshTokens.issue(user);`
    : "";
  const returnTokens = refresh
    ? `  return ctx.json({ accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS });`
    : `  return ctx.json({ accessToken, expiresIn: ACCESS_TTL_SECONDS });`;

  return `import { Type, type Static } from "typebox";
import { post } from "@ignex/core/http";
${libImports}

const LoginBody = Type.Object({
  username: Type.String({ minLength: 3, maxLength: 128 }),
  password: Type.String({ minLength: 1, maxLength: 1024 })
});

export default post(async (ctx) => {
  const body = await ctx.body.json<Static<typeof LoginBody>>();
  const user = await userStore.verify(body.username, body.password);
  if (!user) {
    return ctx.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const accessToken = await auth.issueToken(
    { id: user.username, roles: user.roles },
    { roles: user.roles }
  );${issueRefresh}
${returnTokens}
}, { body: LoginBody });
`;
}

export function registerRouteTemplate(options: { refresh: boolean }): string {
  const { refresh } = options;
  const libImports = refresh
    ? `import { ACCESS_TTL_SECONDS, auth, refreshTokens, userStore } from "../../lib/auth.js";`
    : `import { ACCESS_TTL_SECONDS, auth, userStore } from "../../lib/auth.js";`;
  const issueRefresh = refresh
    ? `
  const refreshToken = await refreshTokens.issue(user);`
    : "";
  const returnTokens = refresh
    ? `  return ctx.json({ accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS }, { status: 201 });`
    : `  return ctx.json({ accessToken, expiresIn: ACCESS_TTL_SECONDS }, { status: 201 });`;

  return `import { Type, type Static } from "typebox";
import { post } from "@ignex/core/http";
${libImports}

const RegisterBody = Type.Object({
  username: Type.String({ minLength: 3, maxLength: 128 }),
  password: Type.String({ minLength: 12, maxLength: 1024 })
});

export default post(async (ctx) => {
  const body = await ctx.body.json<Static<typeof RegisterBody>>();
  const user = await userStore.create(body.username, body.password);
  if (!user) {
    return ctx.json({ error: "User already exists" }, { status: 409 });
  }

  const accessToken = await auth.issueToken(
    { id: user.username, roles: user.roles },
    { roles: user.roles }
  );${issueRefresh}
${returnTokens}
}, { body: RegisterBody });
`;
}

export function refreshRouteTemplate(): string {
  return `import { post } from "@ignex/core/http";
import { ACCESS_TTL_SECONDS, auth, refreshTokens } from "../../lib/auth.js";

export default post(async (ctx) => {
  const body = await ctx.body.json<{ refreshToken?: string }>();
  const data = body.refreshToken ? await refreshTokens.consume(body.refreshToken) : null;

  if (!data) {
    return ctx.json({ error: "Invalid refresh token" }, { status: 401 });
  }

  const user = { username: data.sub, roles: data.roles };
  const [accessToken, refreshToken] = await Promise.all([
    auth.issueToken({ id: user.username, roles: user.roles }, { roles: user.roles }),
    refreshTokens.issue(user)
  ]);

  return ctx.json({ accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS });
});
`;
}

export function logoutRouteTemplate(): string {
  return `import { post } from "@ignex/core/http";
import { refreshTokens } from "../../lib/auth.js";

export default post(async (ctx) => {
  const body = await ctx.body.json<{ refreshToken?: string }>();
  if (body.refreshToken) {
    await refreshTokens.revoke(body.refreshToken);
  }
  return ctx.json({ ok: true });
});
`;
}

export function meRouteTemplate(): string {
  return `import { get } from "@ignex/core/http";
import { getUser } from "@ignex/core";

export const config = { hooks: ["require-auth"] };

export default get((ctx) => ctx.json({ user: getUser(ctx) ?? null }));
`;
}

export function sessionRouteTemplate(): string {
  return `import { get } from "@ignex/core/http";
import { getSession } from "@ignex/core";

export default get(async (ctx) => {
  const session = await getSession(ctx);
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
import { env } from "../config/env.js";

export default get((ctx) =>
  ctx.json({ nodeEnv: env.NODE_ENV, port: env.PORT, debug: env.DEBUG })
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

export function appConfigTemplate(
  options: { middleware?: boolean; plugins?: boolean; https?: boolean; h2?: boolean } = {},
): string {
  const middleware = options.middleware ?? false;
  const hasPlugins = options.plugins ?? false;
  // HTTPS by default; the create wizard (--protocol https2|https|http) picks the
  // transport. HTTP/2 (h2) is an HTTPS-only opt-in — Bun >=1.4.1.
  const https = options.https ?? true;
  const h2 = (options.h2 ?? false) && https;
  const middlewareImports = middleware
    ? `import { middleware } from "./middleware/index.js";
`
    : "";
  // Import under an alias: the exported `plugins` const below must never
  // shadow the import (regression: `export const plugins = [...plugins]`
  // referenced the TDZ binding and crashed with ReferenceError at boot).
  const pluginsImport = hasPlugins
    ? `import { plugins as appPlugins } from "./plugins/index.js";
`
    : "";
  const pluginsSpread = hasPlugins ? "  ...appPlugins,\n" : "";
  const middlewareSpread = middleware ? "  ...middleware,\n" : "";

  // The selected `--features` plugins (cors/rateLimit/security/compression/
  // logger) come from ./plugins/index.js (spread as appPlugins below); debugbar
  // + session + openapi are the baseline every scaffold gets. `server` is typed
  // with the public `ServerConfig` interface so every knob is discoverable and
  // checked (see @ignex/core's http/tls.ts).
  const serverComment = https
    ? `  // HTTPS by default (requires TLS). In dev, ignex auto-generates a local
  // certificate (mkcert -> openssl) and caches it under .ignex/certs; set
  // tls: { certFile, keyFile } to use your own certs, or https: false
  // for plain HTTP/1 — or add h2: true to serve HTTP/2 over TLS.`
    : `  // Plain HTTP/1 — no TLS (selected at scaffold time). To serve HTTPS, set
  // https: true: in dev ignex auto-generates a local certificate (mkcert ->
  // openssl) cached under .ignex/certs; set tls: { certFile, keyFile } to use
  // your own certs. Add h2: true alongside https: true for HTTP/2 over TLS.`;

  const serverBody = [
    "  port: env.PORT,",
    serverComment,
    `  https: ${https ? "true" : "false"}${https && h2 ? "," : ""}`,
    ...(https && h2
      ? [`  h2: true, // HTTP/2 over TLS (ALPN) — Bun >=1.4.1; server.http2 works too`]
      : []),
  ].join("\n");
  return `${middlewareImports}${pluginsImport}import {
  debugbar,
  devSessionSecret,
  openapi,
  session,
  type ServerConfig,
} from "@ignex/core";
import { env } from "./config/env.js";

export const plugins = [
${pluginsSpread}${middlewareSpread}  // Developer dashboard (request waterfall, errors + replay, system profile,
  // SDK list, KT docs) at '/__debugbar'. Enabled only in explicit debug mode
  // (NODE_ENV=development or IGNEX_DEBUG=1) — an unset/ambiguous environment
  // (staging) stays OFF. When disabled the plugin marks itself dev-only and
  // the compiled server omits it entirely — zero per-request cost.
  debugbar(),
  // Local dev secret: stable per-machine generated value (.ignex/dev-session-secret).
  // Production MUST set SESSION_SECRET — the session manager refuses weak or
  // known-default secrets outside explicit local development.
  session({ secret: env.SESSION_SECRET || devSessionSecret(), createIfMissing: true }),
  // OpenAPI docs — 'GET /openapi.json' (spec) + 'GET /openapi' (Scalar UI).
  // In AOT builds the plugin serves the compiler-generated openapi.json.
  openapi()
];
export const server: ServerConfig = {
${serverBody}
};
`;
}
