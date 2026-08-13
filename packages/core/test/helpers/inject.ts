/**
 * @fileoverview In-process request injection for interpreted `createApp` apps.
 *
 * Analogous to Fastify's `app.inject()`: builds a `Request` and runs it
 * through `app.handler()` without spawning a server, so the interpreted
 * request path (lifecycle + plugins + body/headers/cookies + errors) can be
 * unit-tested quickly and deterministically.
 *
 * ```ts
 * const app = createApp({ handler: (ctx) => ctx.json({ ok: true }) });
 * const res = await inject(app, { method: "POST", url: "/x", body: "…" });
 * ```
 */
import type { IgnexApp } from "../../src/index.js";

export interface InjectInit {
  method?: string;
  /** Path or absolute URL. Relative paths resolve against `http://localhost`. */
  url?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
}

export const inject = async (app: IgnexApp, init: InjectInit = {}): Promise<Response> => {
  const { method = "GET", url = "/", headers, body } = init;
  const target = /^https?:\/\//.test(url) ? url : `http://localhost${url}`;
  return app.handler(new Request(target, { method, headers, body }));
};
