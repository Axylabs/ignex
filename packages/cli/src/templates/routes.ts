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

export function authLibTemplate(options: { refresh: boolean }): string {
  const { refresh } = options;
  const imports = refresh
    ? `import {
  createAuthModule,
  createMemorySessionStore,
  createPasswordHasher,
  randomToken,
  type SessionStore,
} from "@ignex/core";`
    : `import { createAuthModule, createPasswordHasher } from "@ignex/core";`;

  const refreshSection = refresh
    ? `
// --- Refresh tokens (opaque, revocable) ---
// Reuses the session-store infrastructure (\`SessionStore\`) so tokens can be
// revoked (logout) and verified server-side. Memory by default; point
// \`refreshStore\` at \`createSqliteSessionStore(...)\` for persistence across
// restarts.
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const refreshStore: SessionStore = createMemorySessionStore({ ttlSeconds: 7 * 24 * 60 * 60 });

export const refreshTokens = {
  /** Issue a new opaque refresh token bound to the user. */
  async issue(user: { username: string; roles: string[] }): Promise<string> {
    const token = randomToken(32);
    await refreshStore.set(
      token,
      { sub: user.username, roles: user.roles },
      { expiresAt: Date.now() + REFRESH_TTL_MS }
    );
    return token;
  },
  /** Resolve a refresh token to its user claims, or null when invalid/expired. */
  async consume(token: string) {
    return await refreshStore.get(token);
  },
  /** Revoke a refresh token (logout). */
  async revoke(token: string): Promise<void> {
    await refreshStore.delete(token);
  }
};
`
    : "";

  return `${imports}

// Ed25519 (EdDSA) JWT auth module — issues short-lived access tokens and
// bootstraps \`JWT_PRIVATE_KEY\` / \`JWT_PUBLIC_KEY\` into \`.env\` on first use.
export const ACCESS_TTL_SECONDS = 15 * 60;

export const auth = createAuthModule({
  mode: "both", // claims: { sub, roles, permissions }
  ttlSeconds: ACCESS_TTL_SECONDS,
  issuer: "ignex-app"
});

// Named hook used by routes via \`config.hooks = ["require-auth"]\`.
export const requireAuth = auth.middleware();

// --- In-memory user store (hashed passwords) ---
// Swap for a real DB (e.g. a ninox collection) in production. The admin seed
// is created on first access so hashing (argon2id native / scrypt fallback)
// runs once at runtime rather than at module load.
const hasher = createPasswordHasher();
const users = new Map<string, { passwordHash: string; roles: string[] }>();
let seeded = false;

async function ensureSeed(): Promise<void> {
  if (seeded) return;
  seeded = true;
  users.set("admin", {
    passwordHash: await hasher.hash("secret"),
    roles: ["admin"]
  });
}

export const userStore = {
  async find(username: string) {
    await ensureSeed();
    return users.get(username) ?? null;
  },
  async create(username: string, password: string, roles: string[] = []) {
    await ensureSeed();
    if (users.has(username)) return null;
    users.set(username, { passwordHash: await hasher.hash(password), roles });
    return { username, roles };
  },
  async verify(username: string, password: string) {
    const entry = await userStore.find(username);
    if (!entry) return null;
    return hasher.verify(password, entry.passwordHash)
      ? { username, roles: entry.roles }
      : null;
  }
};${refreshSection}
`;
}

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

  return `import { post } from "@ignex/core/http";
${libImports}

export default post(async (ctx) => {
  const body = await ctx.body.json<{ username?: string; password?: string }>();

  const user = await userStore.verify(body.username ?? "", body.password ?? "");
  if (!user) {
    return ctx.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const accessToken = await auth.issueToken(
    { id: user.username, roles: user.roles },
    { roles: user.roles }
  );${issueRefresh}
${returnTokens}
});
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

  return `import { post } from "@ignex/core/http";
${libImports}

export default post(async (ctx) => {
  const body = await ctx.body.json<{ username?: string; password?: string; roles?: string[] }>();

  if (!body.username || !body.password) {
    return ctx.json({ error: "username and password are required" }, { status: 400 });
  }

  const user = await userStore.create(body.username, body.password, body.roles ?? ["user"]);
  if (!user) {
    return ctx.json({ error: "User already exists" }, { status: 409 });
  }

  const accessToken = await auth.issueToken(
    { id: user.username, roles: user.roles },
    { roles: user.roles }
  );${issueRefresh}
${returnTokens}
});
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

  // Rotate here if you want refresh-token reuse detection: revoke this token
  // and issue a fresh one alongside the new access token.
  const user = {
    username: String(data.sub ?? "anon"),
    roles: (data.roles as string[] | undefined) ?? []
  };
  const accessToken = await auth.issueToken(
    { id: user.username, roles: user.roles },
    { roles: user.roles }
  );

  return ctx.json({ accessToken, expiresIn: ACCESS_TTL_SECONDS });
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
import { logRequests, markResponse } from "./middleware/log-requests.js";
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
  const lifecycle = middleware
    ? `
export const lifecycle = {
  beforeHandle: [logRequests(), markResponse()]
};
`
    : "";

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
${lifecycle}
export const server: ServerConfig = {
${serverBody}
};
`;
}
