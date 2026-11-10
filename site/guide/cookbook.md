# Cookbook

Short, copy-pasteable recipes for the `@ignex/core` primitive catalog. Every
snippet mirrors code the scaffold (`ignex create`) generates, so it is known
to compile against the current API. New to ignex? Start with
[Getting started](./getting-started).

## Routes & responses

```ts
// src/routes/hello.get.ts → GET /hello
import { get } from "@ignex/core/http";

export default get((ctx) => ctx.text("Hello World"));
// ctx.json(...), ctx.html(...), ctx.text(...), ctx.status / ctx.headers
```

Request bodies — JSON, multipart, form (lazy: parsed only when read):

```ts
// src/routes/upload.post.ts → POST /upload
import { post } from "@ignex/core/http";

export default post(async (ctx) => {
  const form = await ctx.body.formData();
  const file = form.get("file");
  return ctx.json({ uploaded: file instanceof File ? file.name : null }, { status: 201 });
});
```

### The three things every list/detail route repeats

Import the shapes instead of re-deriving them:

```ts
import { get, Uuid, OkResponse, pageSchema, readPagination, pageResponse } from "@ignex/core/http";

const params = Type.Object({ id: Uuid }); // was Type.String({ format: "uuid" })
const response = pageSchema(ItemSchema); // { items, page, pageSize, total, pageCount }

export default get(
  async (ctx) => {
    const page = readPagination(ctx); // ?page=&pageSize=, clamped
    const { rows, total } = await listRows(page); // pass page.limit / page.offset to the query
    return ctx.json(pageResponse(rows, page, total));
  },
  { params, response, detail: { summary: "List rows" } },
);
```

- `readPagination(ctx)` tolerates `?page=abc` and clamps `pageSize` to 100.
- `pageResponse(items, page, total)` builds the envelope `pageSchema`
  describes, so the two cannot drift.
- `OkResponse` is the `{ ok: true }` acknowledgement for deletes/commands.

## Use cases and dependency lifetimes

Keep business rules in `src/use-cases/`, infrastructure behind small
interfaces (ports), and HTTP parsing in routes. `defineUseCase` binds
application dependencies once, then accepts only invocation input:

```ts
// src/use-cases/withdraw.ts
import { defineUseCase } from "@ignex/core";

export const createWithdraw = defineUseCase(
  async ({ accounts }: { readonly accounts: AccountRepository }, input: WithdrawInput) => {
    const updated = applyWithdrawal(await accounts.find(input.accountId), input.amount);
    await accounts.save(updated);
    return updated;
  },
);
```

```ts
// src/routes/accounts/withdraw.post.ts — bind the shared repo at composition root
const withdraw = createWithdraw({ accounts });

export default post(async (ctx) => {
  const input = await ctx.body.json<WithdrawInput>();
  return ctx.json(await withdraw(input));
});
```

Three lifetimes, explicitly: **pure values** (no I/O), **application-scoped
instances** (repositories, pools — concurrency-safe), **request-scoped
values** (user, transaction, locale — never captured in shared closures).
Validate untrusted input before executing a use case in production.

## Errors → HTTP with no adapter

```ts
import { ForbiddenError, NotFoundError } from "@ignex/core";

export default get((ctx) => {
  const user = db.users.find(ctx.params.id);
  if (!user) throw new NotFoundError("User not found"); // → 404
  if (!user.visible) throw new ForbiddenError("Not allowed"); // → 403
  return ctx.json({ user });
});
```

And your own domain error classes become HTTP answers by declaration — see
the [Errors guide](./errors#domain-errors-declare-once-no-mapper-no-try-catch).

## Sessions

```ts
import { get } from "@ignex/core/http";
import { getSession } from "@ignex/core";

export default get(async (ctx) => {
  const session = await getSession(ctx);
  if (!session) return ctx.json({ session: null });

  const visits = ((session.data.visits as number | undefined) ?? 0) + 1;
  session.data.visits = visits;
  await session.save();

  return ctx.json({ id: session.id, visits, isNew: session.isNew });
});
```

## Server-sent events (SSE)

```ts
import { get } from "@ignex/core/http";
import { sse } from "@ignex/core";

export default get(() =>
  sse(async function* () {
    yield { event: "ping", data: Date.now().toString() };
  }),
);
```

## WebSockets

```ts
import { createWSHandler } from "@ignex/core";

export const wsHandler = createWSHandler({
  open(ws) {
    ws.send("Welcome to Ignex");
  },
  message(ws, message) {
    ws.send(String(message));
  },
});
```

Optional dispatch/transport limits (per-connection in-flight cap default
256, socket closes with 1013 at the cap):

```ts
export const wsHandler = createWSHandler(hooks, undefined, {
  maxInflightMessages: 64,
  maxTotalInflightMessages: 512,
  maxPayloadLength: 1024 * 1024,
  idleTimeout: 60,
});
```

## Typed realtime events (@ignex/nova)

Full walkthrough in the [Realtime guide](./realtime#nova-typed-pub-sub-recommended-for-apps).
The short version — a typed wire contract, then typed emit/handle anywhere:

```ts
// src/realtime.ts — the contract
export const realtime = {
  subjectPrefix: "myapp",
  events: {
    "chat.message": Type.Object({ to: Type.String(), body: Type.String() }),
  },
  clientToServer: ["chat.message"],
};
```

```ts
// anywhere — no casts, direction-aware
on("chat.message", (payload, ctx) => {
  emitToUser(payload.to, "chat.delivered", { id: payload.id });
});
```

## Mail & notifications

`createMailer` wraps a standard driver (built-in `log` for dev/tests;
nodemailer SMTP opt-in). `createNotifier` pushes typed events to a user's
sockets with an email fallback for offline users:

```ts
import { createMailer, createNotifier } from "@ignex/core";

const mailer = createMailer(); // dev: log driver — no SMTP needed

const notify = createNotifier({
  mailer,
  emailSubjects: { "order.update": "Your order changed" },
});

await notify.user({ id: "u-42", email: "user@example.com" }, "order.update", {
  orderId: "o-1",
});
```

The mailer never throws on the request path — pair `send` with a durable
job for reliable delivery.

## Caching

```ts
import { get } from "@ignex/core/http";
import { withBrowserCache } from "@ignex/core";

export default get(() => withBrowserCache(ctx.json({ cached: true }), { maxAge: 10 }));
```

Also: `cacheControl`, `HttpResponseCache` (stale-while-revalidate),
`etagWithEncoding`, conditional requests. See [Data](./data).

## Proxying

```ts
import { get } from "@ignex/core/http";
import { proxyRequest } from "@ignex/core";

export default get(() => proxyRequest("https://example.com"));
```

Also `forwardRequest` for pass-through proxying.

## Static files & downloads

```ts
import { get } from "@ignex/core/http";
import { sendFile } from "@ignex/core";

// GET /files/:name — range requests + traversal guard built in
export default get((ctx) => sendFile(ctx, join("public", ctx.params.name)));
```

## Background jobs

```ts
import { createJobQueue, withRetry, withTimeout } from "@ignex/core";

const queue = createJobQueue({ concurrency: 2 });

const task = withTimeout(5000)(
  withRetry(2)(async () => {
    // do work
  }),
);

export default get((ctx) => {
  queue.enqueue("demo", task);
  return ctx.json({ enqueued: true, pending: queue.pending, running: queue.running });
});
```

Crash-recoverable, claim/lease jobs: `createDurableJobQueue` +
`createSqliteJobStore` / `createFileJobStore` — see [Data](./data#background-jobs).

## Templates

Jinja-compatible rendering (native minijinja, JS fallback):

```ts
import { get } from "@ignex/core/http";
import { createTemplateDir, withLayout } from "@ignex/core";
import { join } from "node:path";

export default get(async (ctx) => {
  const registry = await createTemplateDir(join(process.cwd(), "src/views"));
  const page = withLayout(
    (content, data) => registry.render("layout", { ...data, content }),
  )((data) => registry.render("home", data));

  return ctx.html(page({ title: "Ignex app", name: "world" }));
});
```

## i18n

```ts
import { get } from "@ignex/core/http";
import { createI18n } from "@ignex/core";

const i18n = createI18n(
  { en: { greeting: "Hello {name}" }, es: { greeting: "Hola {name}" } },
  { fallbackLocale: "en" },
);

export default get((ctx) => {
  const locale = i18n.locale(ctx);
  return ctx.json({ locale, message: i18n.t("greeting", { name: "world" }, locale) });
});
```

JSON catalogs (`locales/*.json`) load via `createI18nFromDir`; `withI18n`
middleware exposes `ctx.t`.

## Testing

Handlers are ordinary functions — most things are unit-testable without a
server. For end-to-end tests, boot the compiled server the way the scaffold
does:

```ts
// test/app.test.ts — the shape `bun create ignex --features tests` writes
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, expect, test } from "vitest";

const port = 3999;
const baseUrl = `http://127.0.0.1:${port}`;
let server: ChildProcess | null = null;

beforeAll(async () => {
  server = spawn("bun", [".ignex/server.js"], {
    env: { ...process.env, PORT: String(port), IGNEX_HTTPS: "0" },
    stdio: "ignore",
  });
  while (!(await fetch(`${baseUrl}/health`).catch(() => null))?.ok) {
    await new Promise((r) => setTimeout(r, 100));
  }
}, 30_000);

afterAll(() => server?.kill());

test("GET /health responds ok", async () => {
  const res = await fetch(`${baseUrl}/health`);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});
```
